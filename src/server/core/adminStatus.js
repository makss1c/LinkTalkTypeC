/**
 * LinkTalk server — снимок статуса админки, подслушка, остановка передачи
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { describeStatusClient, statusRemoteAddress } = require("../statusClient");
const { describePeerMediaStatus } = require("../mediaStatus");
const { isRunningInContainer } = require("../runtimeEnvironment");
const { stopPeerTransmission } = require("../transmissionControl");
const { getAllUsers, getUserById, getAllConferences, getAllFeeds, getAllProductions, getAllProductionMemberships, getAllMonitorLinks, setMonitorGrant } = require("../dbHandler");
const monitoring = require("../monitoring");
const ns = require("../ns");
const { SERVER_APP_VERSION } = ns.runtime;
const { reloadMonitorLinks } = ns.monitorCache;
const { SERVER_STARTED_AT, app, bridgeControlSessions, bridgeRegistry } = ns.base;
const { areMultipleProductionsEnabled } = ns.config;
const { adminSessions, adminStatusStreams, closeAdminStatusStreamsForToken, isServerRestartSupported, requireAdmin, requireSuperAdmin, restartServerProcess, scheduleAdminStatusBroadcast, writeAdminStatusEvent } = ns.sessions;
const { companionUserState, isCompanionSocketOnline } = ns.companionAuth;
const { getBridgeRegistrySnapshot } = ns.bridgeRegistry;
const { findGuestPeerByGuestId, getPeerActiveTalkTargets, getPeerTalkProducers, isPersistentUserPeer, normalizeRuntimeTalkTargets } = ns.talkTargets;
const { broadcastRuntimeUserStates, findFeedPeerByFeedId, findUserPeerByUserId, syncPeerCompanionState } = ns.companionState;
const { WEB_ACCESS } = ns.listenConfig;

function statusIsoTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : null;
}

function normalizeBridgePlatform(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "macos" || normalized === "darwin" || normalized === "mac") return "macos";
  if (normalized === "windows" || normalized === "win32" || normalized === "win") return "windows";
  if (normalized === "linux") return "linux";
  return "unknown";
}

function describeBridgeStatusClient(platform, host) {
  const normalizedPlatform = normalizeBridgePlatform(platform);
  if (normalizedPlatform === "macos") return "macOS Bridge";
  if (normalizedPlatform === "windows") return "Win Bridge";
  if (normalizedPlatform === "linux") return "Linux Bridge";

  const normalizedHost = String(host || "").toLowerCase();
  if (normalizedHost.includes("coreaudio")) return "macOS Bridge";
  if (normalizedHost.includes("wasapi") || normalizedHost.includes("asio")) return "Win Bridge";
  if (normalizedHost.includes("alsa") || normalizedHost.includes("pulse") || normalizedHost.includes("jack")) {
    return "Linux Bridge";
  }
  return "Bridge";
}

function bridgeInventoryHasAssignment(bridge, direction, assignment) {
  const deviceId = String(assignment?.deviceId || "");
  if (!deviceId) return false;
  const leftChannel = Number(assignment?.leftChannel);
  const rightChannel = Number(assignment?.rightChannel);
  const requiredChannel = Math.max(leftChannel, rightChannel);
  const devices = Array.isArray(bridge?.inventory?.devices) ? bridge.inventory.devices : [];
  const device = devices.find((entry) => (
    entry.direction === direction
    && String(entry.id || "") === deviceId
  ));
  if (!device) return false;
  if (!Number.isInteger(leftChannel) || !Number.isInteger(rightChannel)) return false;
  if (leftChannel < 1 || rightChannel < 1) return false;
  const maxChannels = Number(device.max_channels ?? device.maxChannels ?? 0);
  return maxChannels >= requiredChannel;
}

function buildBridgeDeviceIssues(bridge, users = [], feeds = []) {
  if (!bridge?.id || bridge.stale) return [];
  const bridgeId = String(bridge.id);
  const issues = [];

  for (const user of users) {
    if (!user.bridge_enabled || String(user.bridge_device || "") !== bridgeId) continue;
    const inputOk = bridgeInventoryHasAssignment(bridge, "input", {
      deviceId: user.bridge_input_device,
      leftChannel: user.bridge_input_left_channel,
      rightChannel: user.bridge_input_right_channel,
    });
    const outputOk = bridgeInventoryHasAssignment(bridge, "output", {
      deviceId: user.bridge_output_device,
      leftChannel: user.bridge_output_left_channel,
      rightChannel: user.bridge_output_right_channel,
    });
    if (!inputOk) issues.push(`${user.name}: input device missing`);
    if (!outputOk) issues.push(`${user.name}: output device missing`);
  }

  for (const feed of feeds) {
    if (!feed.bridge_enabled || String(feed.bridge_device || "") !== bridgeId) continue;
    const inputOk = bridgeInventoryHasAssignment(bridge, "input", {
      deviceId: feed.bridge_input_device,
      leftChannel: feed.bridge_input_left_channel,
      rightChannel: feed.bridge_input_right_channel,
    });
    if (!inputOk) issues.push(`${feed.name}: input device missing`);
  }

  return issues;
}

const BROWSER_MEDIA_STATS_STALE_MS = 15_000;
const BRIDGE_NETWORK_STATS_STALE_MS = 30_000;

function normalizeBrowserMediaStats(payload = {}) {
  const roundTripMs = Number(payload?.roundTripMs);
  const packetLossPercent = Number(payload?.packetLossPercent);
  const normalized = {};

  if (Number.isFinite(roundTripMs) && roundTripMs >= 0 && roundTripMs <= 60_000) {
    normalized.roundTripMs = Math.round(roundTripMs);
  }
  if (Number.isFinite(packetLossPercent) && packetLossPercent >= 0 && packetLossPercent <= 100) {
    normalized.packetLossPercent = Math.round(packetLossPercent * 10) / 10;
  }
  for (const key of [
    "jitterMs",
    "jitterBufferMs",
    "packetsLost",
    "packetsReceived",
    "packetsDiscarded",
    "concealedSamples",
    "concealmentEvents",
  ]) {
    const value = Number(payload?.[key]);
    if (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
      normalized[key] = Math.round(value);
    }
  }

  if (Array.isArray(payload?.streams)) {
    normalized.streams = payload.streams.slice(0, 50).map((stream = {}) => {
      const normalizedStream = {};
      for (const key of ["consumerId", "producerId", "streamKey", "targetKey", "type"]) {
        if (typeof stream?.[key] === "string" && stream[key].trim()) {
          normalizedStream[key] = stream[key].trim().slice(0, 160);
        }
      }
      for (const key of [
        "jitterMs",
        "jitterBufferMs",
        "packetsLost",
        "packetsReceived",
        "packetsDiscarded",
        "concealedSamples",
        "concealmentEvents",
      ]) {
        const value = Number(stream?.[key]);
        if (Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
          normalizedStream[key] = Math.round(value);
        }
      }
      const streamLossPercent = Number(stream?.packetLossPercent);
      if (Number.isFinite(streamLossPercent) && streamLossPercent >= 0 && streamLossPercent <= 100) {
        normalizedStream.packetLossPercent = Math.round(streamLossPercent * 10) / 10;
      }
      return normalizedStream;
    }).filter((stream) => stream.consumerId || stream.producerId || stream.streamKey);
  }

  return Object.keys(normalized).length ? normalized : null;
}

function logBrowserMediaStats(peer, socketId, stats) {
  const now = Date.now();
  const previous = peer.browserMediaStats || null;
  const delta = (key) => previous ? Math.max(0, Number(stats[key] || 0) - Number(previous[key] || 0)) : 0;
  const lostDelta = delta("packetsLost");
  const discardedDelta = delta("packetsDiscarded");
  const concealedSamplesDelta = delta("concealedSamples");
  const concealmentEventsDelta = delta("concealmentEvents");
  const previousStreams = new Map(
    (Array.isArray(previous?.streams) ? previous.streams : [])
      .map((stream) => [stream.consumerId || stream.producerId || stream.streamKey, stream])
  );
  const streamProblems = (Array.isArray(stats.streams) ? stats.streams : []).map((stream) => {
    const key = stream.consumerId || stream.producerId || stream.streamKey;
    const previousStream = previousStreams.get(key) || null;
    const streamDelta = (field) => (
      previousStream
        ? Math.max(0, Number(stream[field] || 0) - Number(previousStream[field] || 0))
        : 0
    );
    return {
      stream,
      lostDelta: streamDelta("packetsLost"),
      discardedDelta: streamDelta("packetsDiscarded"),
      concealedSamplesDelta: streamDelta("concealedSamples"),
      concealmentEventsDelta: streamDelta("concealmentEvents"),
    };
  }).filter((entry) => (
    entry.lostDelta > 0
    || entry.discardedDelta > 0
    || entry.concealmentEventsDelta > 0
  ));
  const hasNewProblem = (
    lostDelta > 0
    || discardedDelta > 0
    || concealmentEventsDelta > 0
    || streamProblems.length > 0
  );
  const periodicLogDue = !peer.lastMediaDiagnosticsLogAt || now - peer.lastMediaDiagnosticsLogAt >= 30_000;
  if (!hasNewProblem && !periodicLogDue) return;

  const timestamp = new Date(now).toISOString();
  const label = `${peer.kind || "client"}:${peer.userId ?? peer.feedId ?? peer.name ?? socketId}`;
  const prefix = hasNewProblem ? "[MEDIA][WEBRTC][LOSS]" : "[MEDIA][WEBRTC][STATS]";
  const method = hasNewProblem ? console.warn : console.log;
  method(
    `${prefix} ${timestamp} ${label} socket=${socketId} `
    + `rttMs=${stats.roundTripMs ?? "unknown"} jitterMs=${stats.jitterMs ?? "unknown"} `
    + `jitterBufferMs=${stats.jitterBufferMs ?? "unknown"} lossPct=${stats.packetLossPercent ?? "unknown"} `
    + `packets=recv:${stats.packetsReceived ?? 0},lost:${stats.packetsLost ?? 0}(+${lostDelta}),`
    + `discarded:${stats.packetsDiscarded ?? 0}(+${discardedDelta}) `
    + `concealment=events:${stats.concealmentEvents ?? 0}(+${concealmentEventsDelta}),`
    + `samples:${stats.concealedSamples ?? 0}(+${concealedSamplesDelta},~${Math.round(concealedSamplesDelta / 48)}ms)`
  );
  for (const problem of streamProblems) {
    const stream = problem.stream;
    console.warn(
      `[MEDIA][WEBRTC][SOURCE-LOSS] ${timestamp} ${label} socket=${socketId} `
      + `type=${stream.type || "unknown"} target=${stream.targetKey || "unknown"} `
      + `producer=${stream.producerId || "unknown"} consumer=${stream.consumerId || "unknown"} `
      + `jitterMs=${stream.jitterMs ?? "unknown"} jitterBufferMs=${stream.jitterBufferMs ?? "unknown"} `
      + `lossPct=${stream.packetLossPercent ?? "unknown"} `
      + `packets=recv:${stream.packetsReceived ?? 0},lost:${stream.packetsLost ?? 0}(+${problem.lostDelta}),`
      + `discarded:${stream.packetsDiscarded ?? 0}(+${problem.discardedDelta}) `
      + `concealment=events:${stream.concealmentEvents ?? 0}(+${problem.concealmentEventsDelta}),`
      + `samples:${stream.concealedSamples ?? 0}(+${problem.concealedSamplesDelta},`
      + `~${Math.round(problem.concealedSamplesDelta / 48)}ms)`
    );
  }
  peer.lastMediaDiagnosticsLogAt = now;
}

function getFreshBrowserMediaStats(peer, now = Date.now()) {
  const stats = peer?.browserMediaStats;
  if (!stats || now - Number(stats.reportedAt || 0) > BROWSER_MEDIA_STATS_STALE_MS) return null;
  return {
    roundTripMs: Number.isFinite(stats.roundTripMs) ? stats.roundTripMs : null,
    packetLossPercent: Number.isFinite(stats.packetLossPercent) ? stats.packetLossPercent : null,
  };
}

function isFreshBridgeNetworkMetric(stats, timestampKey, now) {
  const reportedAt = stats?.[timestampKey] ?? stats?.reportedAt;
  return Number.isFinite(reportedAt) && now - reportedAt <= BRIDGE_NETWORK_STATS_STALE_MS;
}

function recordBridgeNetworkStats(session, reportedStats, packetStats, now = Date.now()) {
  const previous = session.networkStats || {};
  const stats = {
    ...previous,
    roundTripReportedAt: previous.roundTripReportedAt ?? previous.reportedAt ?? null,
    packetStatsReportedAt: previous.packetStatsReportedAt ?? previous.reportedAt ?? null,
    reportedAt: now,
  };
  const roundTripMs = reportedStats?.roundTripMs;
  if (Number.isFinite(roundTripMs) && roundTripMs >= 0 && roundTripMs <= 60_000) {
    stats.roundTripMs = Math.round(roundTripMs);
    stats.roundTripReportedAt = now;
  }
  if (packetStats) {
    stats.packetsReceived = packetStats.packetsReceived;
    stats.packetsLost = packetStats.packetsLost;
    const total = stats.packetsReceived + stats.packetsLost;
    stats.packetLossPercent = total > 0 ? Math.round(1000 * stats.packetsLost / total) / 10 : null;
    stats.packetStatsReportedAt = now;
  }
  session.networkStats = stats;
}

function getFreshBridgeNetworkStats(session, now = Date.now()) {
  const stats = session?.networkStats;
  const roundTripFresh = isFreshBridgeNetworkMetric(stats, 'roundTripReportedAt', now);
  const packetsFresh = isFreshBridgeNetworkMetric(stats, 'packetStatsReportedAt', now);
  if (!roundTripFresh && !packetsFresh) return null;
  return {
    roundTripMs: roundTripFresh && Number.isFinite(stats.roundTripMs) ? stats.roundTripMs : null,
    packetLossPercent: packetsFresh && Number.isFinite(stats.packetLossPercent) ? stats.packetLossPercent : null,
  };
}

function getBridgeAggregateNetworkStats(bridgeId, now = Date.now()) {
  const sessions = [...bridgeControlSessions.values()]
    .filter((session) => !session.closed && session.bridgeId === bridgeId)
    .filter((session) => getFreshBridgeNetworkStats(session, now));
  if (!sessions.length) return null;
  const roundTrips = sessions.map((session) => getFreshBridgeNetworkStats(session, now).roundTripMs).filter(Number.isFinite);
  const packetStats = sessions.map((session) => session.networkStats)
    .filter((entry) => isFreshBridgeNetworkMetric(entry, 'packetStatsReportedAt', now)
      && Number.isFinite(entry.packetsReceived) && Number.isFinite(entry.packetsLost));
  const packetsReceived = packetStats.reduce((total, entry) => total + entry.packetsReceived, 0);
  const packetsLost = packetStats.reduce((total, entry) => total + entry.packetsLost, 0);
  return {
    roundTripMs: roundTrips.length
      ? Math.round(roundTrips.reduce((total, value) => total + value, 0) / roundTrips.length)
      : null,
    packetLossPercent: packetsReceived + packetsLost > 0
      ? Math.round(1000 * packetsLost / (packetsReceived + packetsLost)) / 10
      : null,
  };
}

async function collectBridgeInputPacketStats(peer) {
  const producers = [...(peer?.producers?.values() || [])].filter((producer) => !producer.closed && producer.kind === "audio");
  const producerStats = await Promise.all(producers.map((producer) => producer.getStats()));
  let packetsReceived = 0;
  let packetsLost = 0;
  let hasPackets = false;
  for (const stats of producerStats) {
    for (const entry of stats) {
      if (entry.type !== "inbound-rtp") continue;
      const received = Number(entry.packetCount);
      const reportedLost = Number(entry.packetsLost);
      // mediasoup can expose a negative loss correction as an unsigned 32-bit value.
      if (!Number.isSafeInteger(received) || received < 0 || !Number.isSafeInteger(reportedLost)) continue;
      const signedLost = reportedLost > 0x7fffffff && reportedLost <= 0xffffffff
        ? reportedLost - 0x100000000
        : reportedLost;
      // Duplicate/reordered RTP packets can make the signed cumulative loss negative.
      const lost = Math.max(0, signedLost);
      packetsReceived += received;
      packetsLost += lost;
      hasPackets = true;
    }
  }
  return hasPackets ? { packetsReceived, packetsLost } : null;
}

function buildAdminStatusTalkTargets(targets, usersById, conferencesById) {
  return normalizeRuntimeTalkTargets(targets).map((target) => {
    if (target.type === "user") {
      return {
        ...target,
        name: usersById.get(String(target.id))?.name || `User ${target.id}`,
      };
    }
    if (target.type === "conference") {
      return {
        ...target,
        name: conferencesById.get(String(target.id))?.name || `Conference ${target.id}`,
      };
    }
    if (target.type === "guest") {
      return {
        ...target,
        name: findGuestPeerByGuestId(target.id)?.peer?.name || "Guest",
      };
    }
    return target;
  });
}

function notifyMonitorChange(userId) {
  reloadMonitorLinks();
  ns.producerRouting.reconcileAllProducerRecipients();
  for (const peer of ns.bridgeControl.peers.values()) {
    if (!isPersistentUserPeer(peer) || Number(peer.userId) !== Number(userId)) continue;
    try {
      peer.socket.emit("monitor-state", {
        monitors: monitoring.describeMonitorsForUser({
          userId: Number(userId),
          links: ns.monitorCache.monitorLinks,
          nameOfUser: (id) => getUserById(id)?.name || null,
        }),
      });
    } catch (error) {
      console.warn("[MONITOR] Failed to notify user:", error?.message || error);
    }
  }
  scheduleAdminStatusBroadcast("monitor-updated");
}

function buildAdminStatusSnapshot() {
  const now = Date.now();
  const multipleProductionsEnabled = areMultipleProductionsEnabled();
  const allUsers = getAllUsers();
  const allFeeds = getAllFeeds();
  const allConferences = getAllConferences();
  const productionsById = multipleProductionsEnabled
    ? new Map(getAllProductions().map((production) => [String(production.id), production]))
    : new Map();
  const productionIdsByUser = new Map();
  if (multipleProductionsEnabled) {
    for (const membership of getAllProductionMemberships()) {
      const userId = String(membership.user_id);
      if (!productionIdsByUser.has(userId)) productionIdsByUser.set(userId, []);
      productionIdsByUser.get(userId).push(Number(membership.production_id));
    }
  }
  const usersById = new Map(allUsers.map((user) => [String(user.id), user]));
  const conferencesById = new Map(allConferences.map((conference) => [String(conference.id), conference]));
  const users = allUsers
    .filter((user) => !user.is_superadmin && !user.is_guest_profile)
    .map((user) => {
      const found = findUserPeerByUserId(user.id);
      const peer = found?.peer || null;
      const online = Boolean(peer);
      const isBridge = Boolean(peer?.isBridgePeer);
      const activeTargets = peer ? getPeerActiveTalkTargets(peer) : [];
      const talkTargets = buildAdminStatusTalkTargets(activeTargets, usersById, conferencesById);
      const activeProduction = online && multipleProductionsEnabled && peer.productionId != null
        ? productionsById.get(String(peer.productionId)) || null
        : null;
      const bridge = isBridge
        ? bridgeRegistry.get(String(peer.bridgeId)) || null
        : null;
      const networkStats = online
        ? isBridge
          ? getFreshBridgeNetworkStats(bridgeControlSessions.get(found.socketId), now)
          : getFreshBrowserMediaStats(peer, now)
        : null;

      return {
        id: Number(user.id),
        name: user.name,
        online,
        talking: online && activeTargets.length > 0,
        talkLocked: online && activeTargets.length > 0
          && Boolean(companionUserState.get(String(user.id))?.talkLocked),
        talkTargets,
        // LinkTalk: кого этот пользователь сейчас «подслушивает»
        monitoring: monitoring.activeMonitorPairs(ns.monitorCache.monitorLinks)
          .filter((pair) => pair.userId === Number(user.id))
          .map((pair) => ({ id: pair.targetUserId, name: usersById.get(String(pair.targetUserId))?.name || null, forced: pair.forced })),
        productionIds: productionIdsByUser.get(String(user.id)) || [],
        activeProduction: activeProduction
          ? { id: Number(activeProduction.id), name: activeProduction.name }
          : null,
        connectionType: online ? (isBridge ? "bridge" : "browser") : null,
        configuredAsBridge: Boolean(user.bridge_enabled),
        bridgeName: bridge?.name || (isBridge ? peer.bridgeId : null),
        connectedAt: online ? statusIsoTimestamp(peer.connectedAt) : null,
        lastOnlineAt: user.last_online_at || null,
        client: online
          ? (isBridge
              ? `${describeBridgeStatusClient(bridge?.platform, bridge?.host)}: ${bridge?.name || peer.bridgeId || "unknown"}`
              : describeStatusClient(peer.socket, peer.clientType))
          : null,
        remoteAddress: online && !isBridge ? statusRemoteAddress(peer.socket, WEB_ACCESS) : null,
        mediaStatus: online ? describePeerMediaStatus(peer) : null,
        networkStats,
      };
    });

  const feeds = allFeeds.map((feed) => {
    const found = findFeedPeerByFeedId(feed.id);
    const peer = found?.peer || null;
    const online = Boolean(peer);
    const isBridge = Boolean(peer?.isBridgePeer);
    const bridge = isBridge
      ? bridgeRegistry.get(String(peer.bridgeId)) || null
      : null;
    const networkStats = online
      ? isBridge
        ? getFreshBridgeNetworkStats(bridgeControlSessions.get(found.socketId), now)
        : getFreshBrowserMediaStats(peer, now)
      : null;

    return {
      id: Number(feed.id),
      name: feed.name,
      online,
      connectionType: online ? (isBridge ? "bridge" : "browser") : null,
      configuredAsBridge: Boolean(feed.bridge_enabled),
      bridgeName: bridge?.name || (isBridge ? peer.bridgeId : null),
      connectedAt: online ? statusIsoTimestamp(peer.connectedAt) : null,
      lastSeenAt: online ? statusIsoTimestamp(peer.lastSeenAt || peer.connectedAt) : null,
      client: online
        ? (isBridge
            ? `${describeBridgeStatusClient(bridge?.platform, bridge?.host)}: ${bridge?.name || peer.bridgeId || "unknown"}`
            : describeStatusClient(peer.socket, peer.clientType))
        : null,
      remoteAddress: online && !isBridge ? statusRemoteAddress(peer.socket, WEB_ACCESS) : null,
      mediaStatus: online ? describePeerMediaStatus(peer) : null,
      networkStats,
    };
  });

  const bridges = getBridgeRegistrySnapshot().map((bridge) => {
    const devices = Array.isArray(bridge.inventory?.devices) ? bridge.inventory.devices : [];
    const deviceIssues = buildBridgeDeviceIssues(bridge, allUsers, allFeeds);
    return {
      id: bridge.id,
      name: bridge.name,
      platform: bridge.platform,
      host: bridge.host,
      online: !bridge.stale,
      stale: bridge.stale,
      connectedAt: bridge.connectedAt,
      lastSeenAt: bridge.lastSeenAt,
      remoteAddress: bridge.remoteAddress,
      networkStats: bridge.stale ? null : getBridgeAggregateNetworkStats(bridge.id, now),
      client: describeBridgeStatusClient(bridge.platform, bridge.host),
      inventory: bridge.inventory,
      deviceMissing: deviceIssues.length > 0,
      deviceIssues,
      inputDevices: devices.filter((device) => device.direction === "input").length,
      outputDevices: devices.filter((device) => device.direction === "output").length,
    };
  });

  const companionSockets = ns.companionAuth.companionNamespace?.sockets
    ? [...ns.companionAuth.companionNamespace.sockets.values()]
    : [];
  const companions = companionSockets.map((socket) => {
    const auth = socket.data?.companionAuth || {};
    const fallbackName = auth.type === "session" && auth.userName
      ? `Companion for ${auth.userName}`
      : `Companion ${String(socket.id).slice(0, 8)}`;
    return {
      id: socket.id,
      name: socket.data?.instanceName || fallbackName,
      online: isCompanionSocketOnline(socket, now),
      authType: auth.type || "unknown",
      scope: auth.type === "api-key" ? "Global API key" : (auth.userName || "User session"),
      userId: auth.userId ?? null,
      connectedAt: statusIsoTimestamp(socket.data?.connectedAt),
      lastSeenAt: statusIsoTimestamp(socket.data?.lastSeenAt || socket.data?.connectedAt),
      remoteAddress: statusRemoteAddress(socket, WEB_ACCESS),
      client: describeStatusClient(socket),
    };
  });

  const livePeers = [...ns.bridgeControl.peers.values()];
  return {
    appVersion: SERVER_APP_VERSION,
    generatedAt: new Date(now).toISOString(),
    serverStartedAt: statusIsoTimestamp(SERVER_STARTED_AT),
    runningInContainer: isRunningInContainer(),
    restartSupported: isServerRestartSupported(),
    multipleProductionsEnabled,
    productions: [...productionsById.values()].map(({ id, name }) => ({ id: Number(id), name })),
    users,
    feeds,
    bridges,
    companions,
    summary: {
      usersOnline: users.filter((user) => user.online).length,
      usersTotal: users.length,
      feedsOnline: feeds.filter((feed) => feed.online).length,
      feedsTotal: feeds.length,
      bridgesOnline: bridges.filter((bridge) => bridge.online).length,
      bridgesTotal: bridges.length,
      companionsOnline: companions.filter((companion) => companion.online).length,
      guestsOnline: livePeers.filter((peer) => peer.kind === "guest" && peer.guestId).length,
    },
  };
}

app.get("/admin/status", requireAdmin, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(buildAdminStatusSnapshot());
});

async function forceStopUserTransmission(userId) {
  const found = findUserPeerByUserId(userId);
  if (!found?.peer) return null;

  const { socketId, peer } = found;
  const talkProducers = getPeerTalkProducers(peer, { includePaused: true });
  const result = await stopPeerTransmission(peer, talkProducers);

  for (const producer of talkProducers) {
    if (String(producer?.appData?.type || "").trim().toLowerCase() === "talk") {
      ns.producerRouting.syncProducerRecipients({ producer, speakerSocketId: socketId });
    }
  }

  try {
    peer.socket?.emit("force-stop-transmission", {
      reason: "admin-stop-transmission",
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn(`[ADMIN] Failed to notify user ${userId} about stopped transmission:`, error?.message || error);
  }

  syncPeerCompanionState(peer, { reason: "admin-stop-transmission" });
  broadcastRuntimeUserStates("admin-stop-transmission");

  return result;
}

app.get("/api/monitor", requireAdmin, (req, res) => {
  res.json({ links: getAllMonitorLinks() });
});

// body: { userId, targetUserId, allowed?: boolean (по умолчанию true), forced?: boolean }
app.put("/api/monitor", requireAdmin, (req, res) => {
  const { userId, targetUserId, allowed = true, forced = false } = req.body || {};
  try {
    setMonitorGrant(userId, targetUserId, { allowed: allowed !== false, forced: Boolean(forced) });
  } catch (error) {
    return res.status(400).json({ error: error?.message || "Invalid monitor pair" });
  }
  notifyMonitorChange(Number(userId));
  res.json({ links: getAllMonitorLinks() });
});

app.post("/admin/users/:id/stop-transmission", requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  const user = getUserById(userId);
  if (!user || user.is_superadmin || user.is_guest_profile) {
    return res.status(404).json({ error: "User not found" });
  }

  try {
    const result = await forceStopUserTransmission(userId);
    if (!result) {
      return res.status(409).json({ error: "User is not online" });
    }
    if (result.errors.length > 0) {
      console.error(`[ADMIN] Failed to stop all transmission producers for user ${userId}`, result.errors);
      return res.status(500).json({ error: "Failed to stop all active transmission producers" });
    }
    console.log(
      `[ADMIN] Stopped transmission for user ${userId} (${user.name}); `
      + `paused=${result.pausedProducerCount}, closed=${result.closedProducerCount}`
    );
    return res.json({
      ok: true,
      stopped: result.hadActiveTransmission,
      pausedProducerCount: result.pausedProducerCount,
      closedProducerCount: result.closedProducerCount,
    });
  } catch (error) {
    console.error(`[ADMIN] Failed to stop transmission for user ${userId}:`, error);
    return res.status(500).json({ error: "Failed to stop transmission" });
  }
});

app.post("/admin/restart", requireAdmin, requireSuperAdmin, (req, res) => {
  if (!isServerRestartSupported()) {
    return res.status(409).json({ error: "Server restart is not available for unmanaged command-line starts" });
  }
  if (ns.sessions.containerRestartScheduled) {
    return res.status(409).json({ error: "A server restart is already in progress" });
  }

  res.status(202).json({ restarting: true });
  restartServerProcess();
});

app.get("/admin/status/events", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  req.socket?.setTimeout?.(0);

  const stream = {
    res,
    token: req.adminToken,
    heartbeat: null,
  };
  adminStatusStreams.add(stream);
  res.write("retry: 3000\n\n");
  writeAdminStatusEvent(stream, "status", {
    reason: "initial",
    snapshot: buildAdminStatusSnapshot(),
  });

  stream.heartbeat = setInterval(() => {
    const session = adminSessions.get(stream.token);
    if (!session || session.expiresAt <= Date.now()) {
      closeAdminStatusStreamsForToken(stream.token);
      return;
    }
    try {
      res.write(": heartbeat\n\n");
    } catch {
      adminStatusStreams.delete(stream);
      clearInterval(stream.heartbeat);
    }
  }, 25_000);

  req.on("close", () => {
    adminStatusStreams.delete(stream);
    clearInterval(stream.heartbeat);
  });
});

app.get("/admin/bridges", requireAdmin, (req, res) => {
  res.json({ bridges: getBridgeRegistrySnapshot() });
});
Object.assign(ns.adminStatus, {
  buildAdminStatusSnapshot,
  collectBridgeInputPacketStats,
  logBrowserMediaStats,
  normalizeBridgePlatform,
  normalizeBrowserMediaStats,
  notifyMonitorChange,
  recordBridgeNetworkStats,
});
