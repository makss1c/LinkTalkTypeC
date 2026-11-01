/**
 * LinkTalk server — управление мостом, диагностика медиа
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const crypto = require("crypto");
const { normalizeSocketAddress } = require("../mediaNetwork");
const { resolveProducerReconciliationDelivery } = require("../producerReconciliation");
const { updateUserLastOnline, getUserTargetAudioStates } = require("../dbHandler");
const ns = require("../ns");
const { BRIDGE_CONTROL_SESSION_STALE_MS, BRIDGE_RTP_HANDSHAKE_TIMEOUT_MS, bridgeControlSessions, bridgeRegistry } = ns.base;
const { getEffectiveConferencesForPeer, getEffectiveFeedIdsForPeer } = ns.config;
const { scheduleAdminStatusBroadcast } = ns.sessions;
const { buildBridgeRuntimeConfig, normalizeBridgeId, normalizeBridgeRegistryText } = ns.bridgeRegistry;
const { broadcastRuntimeUserStates, failPendingCommandsForUser, findFeedPeerByFeedId, findUserPeerByUserId, syncPeerCompanionState, updateCompanionUserState } = ns.companionState;

ns.bridgeControl.worker = undefined; ns.bridgeControl.router = undefined;
const peers = new Map();
const GATEWAY_OPUS_PAYLOAD_TYPE = 100;
const GATEWAY_OPUS_SSRC = 11111111;

function buildGatewayAudioRtpParameters({
  payloadType = GATEWAY_OPUS_PAYLOAD_TYPE,
  ssrc = GATEWAY_OPUS_SSRC,
  cname = "linktalk-radio-gateway",
  stereo = false,
} = {}) {
  return {
    codecs: [
      {
        mimeType: "audio/opus",
        payloadType,
        clockRate: 48000,
        channels: 2,
        parameters: {
          "sprop-stereo": stereo ? 1 : 0,
          ...(stereo ? { stereo: 1 } : {}),
        },
        rtcpFeedback: [],
      },
    ],
    encodings: [{ ssrc }],
    rtcp: {
      cname,
      reducedSize: true,
      mux: true,
    },
  };
}

function attachProducerMediaDiagnostics(producer, label) {
  if (!producer?.on) return;
  let previousScore = null;
  producer.on("score", (scores = []) => {
    const compact = (Array.isArray(scores) ? scores : []).map((entry) => ({
      ssrc: entry?.ssrc ?? null,
      score: entry?.score ?? null,
    }));
    const serialized = JSON.stringify(compact);
    if (serialized === previousScore) return;
    previousScore = serialized;
    const degraded = compact.some((entry) => Number(entry.score) < 10);
    const method = degraded ? console.warn : console.log;
    method(
      `[MEDIA][RTP][PRODUCER-SCORE] ${new Date().toISOString()} ${label} `
      + `producer=${producer.id} scores=${serialized}`
    );
  });
}

function attachWebRtcTransportDiagnostics(socketId, direction, transport) {
  if (!transport?.on) return;
  const log = (event, state, extra = "") => {
    console.log(
      `[MEDIA][WEBRTC][SERVER-TRANSPORT] ${new Date().toISOString()} socket=${socketId} `
      + `direction=${direction} transport=${transport.id} event=${event} state=${state || "unknown"}`
      + (extra ? ` ${extra}` : "")
    );
    const peer = peers.get(socketId);
    if ((direction === "send" ? peer?.sendTransport : peer?.recvTransport) === transport) {
      scheduleAdminStatusBroadcast("server-media-state-updated");
    }
  };
  transport.on("icestatechange", (state) => log("ice-state", state));
  transport.on("iceselectedtuplechange", (tuple) => log(
    "ice-selected-tuple",
    transport.iceState,
    `tuple=${tuple?.protocol || "unknown"}:${tuple?.remoteIp || "unknown"}:${tuple?.remotePort || "unknown"}`
  ));
  transport.on("dtlsstatechange", (state) => log("dtls-state", state));
  transport.observer?.on?.("close", () => log("close", "closed"));
}

function queueBridgeControlEvent(session, event, payload = {}) {
  if (!session || session.closed) return;
  const relevantEvents = new Set([
    "new-producer",
    "producer-closed",
    "consumer-closed",
    "incoming-talk-state",
    "api-talk-command",
    "api-target-audio-command",
    "panel-command",
    "panel-state-request",
    "session-kicked",
  ]);
  if (!relevantEvents.has(event)) return;
  const entry = {
    id: crypto.randomUUID(),
    event,
    payload,
    at: new Date().toISOString(),
  };
  const deliveredStreams = writeBridgeControlEventToStreams(session, entry);
  if (deliveredStreams > 0) return;

  session.events.push(entry);
  if (session.events.length > 250) {
    session.events.splice(0, session.events.length - 250);
  }
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeBridgeControlEventToStreams(session, entry) {
  if (!session?.eventStreams?.size) return 0;
  let delivered = 0;
  for (const stream of [...session.eventStreams]) {
    try {
      writeSseEvent(stream.res, "bridge-event", entry);
      delivered += 1;
    } catch {
      session.eventStreams.delete(stream);
      clearInterval(stream.heartbeat);
    }
  }
  return delivered;
}

function closeBridgeControlSession(sessionId, reason = "bridge-session-closed") {
  const session = bridgeControlSessions.get(String(sessionId));
  if (!session || session.closed) return false;
  const sessionAgeMs = Math.max(0, Date.now() - Number(session.createdAt || Date.now()));
  console.log(
    `[MEDIA][BRIDGE][SESSION] close ${session.bridgeId}/${session.kind}:${session.userId ?? session.feedId} `
    + `id=${session.id} reason=${JSON.stringify(String(reason))} ageMs=${sessionAgeMs} `
    + `producer=${session.peer?.producers?.size || 0}`
  );
  session.closed = true;
  for (const stream of [...(session.eventStreams || [])]) {
    try {
      writeSseEvent(stream.res, "session-closed", { reason });
      stream.res.end();
    } catch {}
    clearInterval(stream.heartbeat);
  }
  session.eventStreams?.clear();

  const peer = peers.get(session.id);
  const disconnectedUserId = peer?.userId ?? null;
  const disconnectedUserName = peer?.name || null;
  if (peer) {
    for (const producer of peer.producers.values()) {
      try {
        producer.close();
      } catch {}
    }
    for (const consumer of peer.consumers.values()) {
      try {
        consumer.close();
      } catch {}
      try {
        if (consumer.__plainTransport && !consumer.__plainTransport.closed) {
          consumer.__plainTransport.close();
        }
      } catch {}
    }
    try {
      if (peer.plainSendTransport && !peer.plainSendTransport.closed) {
        peer.plainSendTransport.close();
      }
    } catch {}
  }

  peers.delete(session.id);
  bridgeControlSessions.delete(session.id);

  if (disconnectedUserId !== null && !findUserPeerByUserId(disconnectedUserId)) {
    updateUserLastOnline(disconnectedUserId);
    updateCompanionUserState(disconnectedUserId, {
      userName: disconnectedUserName,
      online: false,
      socketId: null,
      talking: false,
      talkLocked: false,
      currentTarget: null,
      currentTargets: [],
      targetAudioStates: [],
      lastSpokeAt: Date.now(),
    }, {
      reason,
      fallbackName: disconnectedUserName,
    });
    failPendingCommandsForUser(disconnectedUserId, reason);
  }

  ns.producerRouting.emitUserListToOperators();
  broadcastRuntimeUserStates(reason);
  return true;
}

function createBridgeControlSession({ bridgeId, userId = null, feedId = null, portId = null, remoteAddress = null }) {
  const config = buildBridgeRuntimeConfig(bridgeId);
  const normalizedPortId = typeof portId === "string" && portId.trim() ? portId.trim() : null;
  const numericUserId = userId !== null && userId !== undefined ? Number(userId) : null;
  const numericFeedId = feedId !== null && feedId !== undefined ? Number(feedId) : null;
  const port = config.ports.find((entry) => {
    if (normalizedPortId) return String(entry.id) === normalizedPortId;
    if (Number.isFinite(numericUserId)) {
      return entry.kind === "user" && Number(entry.userId) === numericUserId;
    }
    if (Number.isFinite(numericFeedId)) {
      return entry.kind === "feed" && Number(entry.feedId) === numericFeedId;
    }
    return false;
  });
  if (!port) {
    throw new Error("Bridge endpoint is not configured for this bridge");
  }

  const isFeedPort = port.kind === "feed";
  const existing = isFeedPort
    ? findFeedPeerByFeedId(port.feedId)
    : findUserPeerByUserId(port.userId);
  if (existing) {
    try {
      existing.peer?.socket?.emit("session-kicked", {
        reason: "bridge-session-replaced",
      });
    } catch {}
    const existingBridgeSession = bridgeControlSessions.get(existing.socketId);
    if (existingBridgeSession) {
      closeBridgeControlSession(existing.socketId, "bridge-session-replaced");
    } else {
      try {
        existing.peer?.socket?.disconnect(true);
      } catch {}
    }
  }

  const entityType = isFeedPort ? "feed" : "user";
  const entityId = isFeedPort ? Number(port.feedId) : Number(port.userId);
  const id = `bridge:${normalizeBridgeId(bridgeId)}:${entityType}:${entityId}:${crypto.randomUUID()}`;
  const session = {
    id,
    bridgeId: normalizeBridgeId(bridgeId),
    kind: entityType,
    userId: isFeedPort ? null : Number(port.userId),
    feedId: isFeedPort ? Number(port.feedId) : null,
    productionId: null,
    port,
    events: [],
    eventStreams: new Set(),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    closed: false,
  };
  const registryEntry = bridgeRegistry.get(session.bridgeId);
  const normalizedRemoteAddress = normalizeBridgeRegistryText(remoteAddress, null);
  if (registryEntry && normalizedRemoteAddress) {
    registryEntry.remoteAddress = normalizedRemoteAddress;
  }
  const virtualSocket = {
    id,
    emit(event, payload) {
      const eventPayload = event === "new-producer" && payload?.peerId && payload?.producerId
        ? buildBridgeProducerPayload(payload.peerId, payload.producerId, payload.appData)
        : payload;
      queueBridgeControlEvent(session, event, eventPayload);
      return true;
    },
    disconnect() {
      closeBridgeControlSession(id, "bridge-session-disconnected");
    },
  };
  const peer = {
    socket: virtualSocket,
    userId: isFeedPort ? null : Number(port.userId),
    feedId: isFeedPort ? Number(port.feedId) : null,
    guestId: null,
    guestProfileUserId: null,
    name: port.label,
    kind: entityType,
    productionId: null,
    consumers: new Map(),
    producers: new Map(),
    activeTalkTargets: [],
    pttTalking: false,
    pttStartedAt: 0,
    plainSendTransport: null,
    isBridgePeer: true,
    bridgeId: session.bridgeId,
    connectedAt: session.createdAt,
  };
  session.peer = peer;
  bridgeControlSessions.set(id, session);
  peers.set(id, peer);
  console.log(
    `[MEDIA][BRIDGE][SESSION] open ${session.bridgeId}/${session.kind}:${session.userId ?? session.feedId} `
    + `id=${session.id} port=${session.port.id}`
  );

  if (!isFeedPort) {
    updateUserLastOnline(peer.userId);
    updateCompanionUserState(peer.userId, {
      userName: peer.name,
      online: true,
      socketId: id,
      targetAudioStates: getUserTargetAudioStates(peer.userId),
    }, {
      reason: "bridge-user-online",
      fallbackName: peer.name,
    });
    syncPeerCompanionState(peer, { reason: "bridge-user-online" });
  }
  ns.producerRouting.emitUserListToOperators();
  broadcastRuntimeUserStates(isFeedPort ? "bridge-feed-online" : "bridge-user-online");
  return session;
}

function finiteDiagnosticCounter(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function logBridgeMediaDiagnostics(session, payload) {
  const input = payload?.input && typeof payload.input === "object" ? payload.input : null;
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const label = `${session.bridgeId}/${session.kind}:${session.userId ?? session.feedId}`;
  const previousOutputs = session.mediaOutputDiagnostics || {};
  const nextOutputs = Object.create(null);
  for (const output of Array.isArray(payload?.outputs) ? payload.outputs : []) {
    const streamId = String(output?.streamId || "unknown").slice(0, 160);
    const warningCount = finiteDiagnosticCounter(output?.ffmpegWarningCount);
    const previousWarningCount = finiteDiagnosticCounter(previousOutputs[streamId]?.ffmpegWarningCount);
    const warningDelta = Math.max(0, warningCount - previousWarningCount);
    const lastWarning = typeof output?.lastFfmpegWarning === "string"
      ? output.lastFfmpegWarning.trim().slice(0, 500)
      : "";
    if (warningDelta > 0) {
      console.warn(
        `[MEDIA][BRIDGE][FFMPEG] ${timestamp} ${label} output=${streamId} `
        + `warnings=+${warningDelta}/${warningCount}`
        + (lastWarning ? ` last=${JSON.stringify(lastWarning)}` : "")
      );
    }
    nextOutputs[streamId] = {
      ffmpegWarningCount: warningCount,
      decodedFrames: finiteDiagnosticCounter(output?.decodedFrames),
    };
  }
  session.mediaOutputDiagnostics = nextOutputs;
  if (!input) return;

  const current = {
    capturedFrames: finiteDiagnosticCounter(input.capturedFrames),
    droppedChunks: finiteDiagnosticCounter(input.droppedChunks),
    droppedFrames: finiteDiagnosticCounter(input.droppedFrames),
    ffmpegWarningCount: finiteDiagnosticCounter(input.ffmpegWarningCount),
    rmsDb: Number.isFinite(Number(input.rmsDb)) ? Number(input.rmsDb) : null,
    lastFfmpegWarning: typeof input.lastFfmpegWarning === "string"
      ? input.lastFfmpegWarning.trim().slice(0, 500)
      : "",
    reportedAt: now,
  };
  const previous = session.mediaDiagnostics || null;

  if (previous) {
    const droppedChunksDelta = Math.max(0, current.droppedChunks - previous.droppedChunks);
    const droppedFramesDelta = Math.max(0, current.droppedFrames - previous.droppedFrames);
    const warningDelta = Math.max(0, current.ffmpegWarningCount - previous.ffmpegWarningCount);
    if (droppedChunksDelta > 0 || droppedFramesDelta > 0) {
      console.warn(
        `[MEDIA][BRIDGE][DROP] ${timestamp} ${label} `
        + `chunks=+${droppedChunksDelta}/${current.droppedChunks} `
        + `frames=+${droppedFramesDelta}/${current.droppedFrames}`
      );
    }
    if (warningDelta > 0) {
      console.warn(
        `[MEDIA][BRIDGE][FFMPEG] ${timestamp} ${label} warnings=+${warningDelta}/${current.ffmpegWarningCount}`
        + (current.lastFfmpegWarning ? ` last=${JSON.stringify(current.lastFfmpegWarning)}` : "")
      );
    }
    if (current.capturedFrames === previous.capturedFrames && now - previous.reportedAt >= 5_000) {
      console.warn(`[MEDIA][BRIDGE][STALL] ${timestamp} ${label} capturedFrames=${current.capturedFrames}`);
    }
  }

  if (!session.lastMediaHealthLogAt || now - session.lastMediaHealthLogAt >= 60_000) {
    console.log(
      `[MEDIA][BRIDGE][HEALTH] ${timestamp} ${label} capturedFrames=${current.capturedFrames} `
      + `droppedChunks=${current.droppedChunks} droppedFrames=${current.droppedFrames} `
      + `ffmpegWarnings=${current.ffmpegWarningCount} rmsDb=${current.rmsDb ?? "unknown"}`
    );
    session.lastMediaHealthLogAt = now;
  }
  session.mediaDiagnostics = current;
}

function resolveBridgeRequestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return normalizeSocketAddress(forwarded || req.socket?.remoteAddress);
}

function waitForBridgeRtpHandshake(transport) {
  const currentTuple = transport?.tuple;
  if (currentTuple?.remoteIp && currentTuple?.remotePort) {
    return Promise.resolve(currentTuple);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      transport?.off?.("tuple", onTuple);
      transport?.observer?.off?.("close", onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onTuple = (tuple) => {
      if (tuple?.remoteIp && tuple?.remotePort) finish(resolve, tuple);
    };
    const onClose = () => {
      finish(reject, new Error("Bridge RTP transport closed before the handshake completed"));
    };

    transport?.on?.("tuple", onTuple);
    transport?.observer?.on?.("close", onClose);
    const tupleAfterListeners = transport?.tuple;
    if (tupleAfterListeners?.remoteIp && tupleAfterListeners?.remotePort) {
      finish(resolve, tupleAfterListeners);
      return;
    }
    timer = setTimeout(() => {
      const error = new Error(
        "Bridge RTP handshake timed out. Check the server announced media address and UDP RTC port forwarding."
      );
      error.code = "BRIDGE_RTP_HANDSHAKE_TIMEOUT";
      finish(reject, error);
    }, BRIDGE_RTP_HANDSHAKE_TIMEOUT_MS);
  });
}

function buildBridgeProducerPayload(peerId, producerId, appData, { retainOnly = false } = {}) {
  const speakerPeer = peers.get(peerId);
  return {
    peerId,
    producerId,
    appData,
    retainOnly: Boolean(retainOnly),
    speakerUserId: speakerPeer?.userId ?? speakerPeer?.guestProfileUserId ?? null,
    speakerName: speakerPeer?.name || null,
    speakerKind: speakerPeer?.kind || null,
  };
}

function listActiveProducersForPeer(peer, peerId) {
  if (!peer || peer.kind === "feed") return [];
  const response = [];
  let conferenceIds = null;
  let feedIds = null;
  const loadConferenceIds = () => {
    if (conferenceIds !== null) return conferenceIds;
    conferenceIds = new Set(
      getEffectiveConferencesForPeer(peer).map((conference) => String(conference.id))
    );
    return conferenceIds;
  };
  const loadFeedIds = () => {
    if (feedIds !== null) return feedIds;
    feedIds = new Set(getEffectiveFeedIdsForPeer(peer).map((id) => String(id)));
    return feedIds;
  };

  for (const [otherPeerId, otherPeer] of peers) {
    if (otherPeerId === peerId) continue;
    for (const [producerId, producer] of otherPeer.producers) {
      if (!producer || producer.closed) continue;
      const appData = producer.appData;
      const type = String(appData?.type || "").trim().toLowerCase();
      let activeDelivery = null;

      if (!producer.paused) {
        if (type === "feed" && loadFeedIds().has(String(appData.id))) {
          activeDelivery = { recipientSocketId: peerId, appData };
        } else if (type === "conference" && loadConferenceIds().has(String(appData.id))) {
          activeDelivery = { recipientSocketId: peerId, appData };
        } else if (["user", "talk", "guest"].includes(type)) {
          activeDelivery = ns.producerRouting.resolveProducerRecipientDeliveries({
            appData,
            speakerSocketId: otherPeerId,
          }).find((candidate) => candidate.recipientSocketId === peerId) || null;
        }
      }

      const reconciliationDelivery = resolveProducerReconciliationDelivery({
        producer,
        recipientSocketId: peerId,
        activeDelivery,
      });
      if (!reconciliationDelivery?.appData) continue;
      response.push(buildBridgeProducerPayload(
        otherPeerId,
        producerId,
        reconciliationDelivery.appData,
        { retainOnly: reconciliationDelivery.retainOnly }
      ));
    }
  }
  return response;
}

const bridgeControlSessionCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - BRIDGE_CONTROL_SESSION_STALE_MS;
  for (const session of bridgeControlSessions.values()) {
    if (session.lastSeenAt < cutoff) {
      closeBridgeControlSession(session.id, "bridge-session-timeout");
    }
  }
}, 5_000);
bridgeControlSessionCleanupTimer.unref?.();
Object.assign(ns.bridgeControl, {
  GATEWAY_OPUS_PAYLOAD_TYPE,
  GATEWAY_OPUS_SSRC,
  attachProducerMediaDiagnostics,
  attachWebRtcTransportDiagnostics,
  buildGatewayAudioRtpParameters,
  closeBridgeControlSession,
  createBridgeControlSession,
  listActiveProducersForPeer,
  logBridgeMediaDiagnostics,
  peers,
  queueBridgeControlEvent,
  resolveBridgeRequestIp,
  waitForBridgeRtpHandshake,
  writeSseEvent,
});
