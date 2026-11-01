/**
 * LinkTalk server — обработчики Socket.IO (подключение клиентов)
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const crypto = require("crypto");
const { normalizeRegisteredClientType } = require("../statusClient");
const { resetPeerMediaTransportStatus, updatePeerMediaTransportStatus } = require("../mediaStatus");
const { buildWebRtcListenInfos } = require("../webrtcConfig");
const { selectMediaRouteAddress } = require("../mediaNetwork");
const { resolveProducerReconciliationDelivery } = require("../producerReconciliation");
const { normalize: normalizeUserAudioSettings } = require("../../../public/userAudioSettings");
const { updateUserLastOnline, getUserById, getUserAudioSettings, getUserPanelSettings, updateUserPanelSettings, mergeUserTargetAudioStates, updateUserAudioSettings, getAllConferences, getFeedById, getUserTargetAudioStates, setMonitorEnabled } = require("../dbHandler");
const monitoring = require("../monitoring");
const ns = require("../ns");
const { CLIENT_ICE_CONFIG } = ns.runtime;
const { getActiveRtcAddresses, getEffectiveConferencesForPeer, getEffectiveFeedIdsForPeer, getEnabledProductionsForUser, loadRuntimeConfig, normalizeActiveProductionId, normalizeGuestDisplayName, resolveGuestLoginSettings, resolveTransportAnnouncedAddress } = ns.config;
const { getBrowserSessionFromCookieHeader, scheduleAdminStatusBroadcast } = ns.sessions;
const { extractCompanionApiKeyFromSocket, resolveCompanionAuth } = ns.companionAuth;
const { getPeerActiveTalkProducers, getPeerTalkProducers, isOperatorPeer, isPersistentUserPeer, normalizeRuntimeTalkTarget, normalizeRuntimeTalkTargets } = ns.talkTargets;
const { broadcastRuntimeUserStates, buildCompanionUserState, disconnectUserPeerForLogout, emitCompanionEvent, failPendingCommandsForUser, findUserPeerByUserId, settleCompanionPendingCommand, syncPeerCompanionState, updateCompanionUserState } = ns.companionState;
const { emitPeerTallyState } = ns.listenConfig;
const { getResolvedUserAudioSettings, isTargetRearrangeAllowed } = ns.routesUsers;
const { logBrowserMediaStats, normalizeBrowserMediaStats, notifyMonitorChange } = ns.adminStatus;
const { io } = ns.webServer;
const { GATEWAY_OPUS_PAYLOAD_TYPE, GATEWAY_OPUS_SSRC, attachProducerMediaDiagnostics, attachWebRtcTransportDiagnostics, buildGatewayAudioRtpParameters, peers } = ns.bridgeControl;
const { warnIfDockerAnnouncedIpLooksInternal } = ns.mediaInit;
const { announceProducerToRecipients, emitUserListToOperators, reconcileAllProducerRecipients, remotePanels, resolveProducerRecipientDeliveries, syncProducerRecipients } = ns.producerRouting;

io.on("connection", (socket) => {
  socket.on("connection-health", (acknowledge) => {
    if (typeof acknowledge === "function") acknowledge(true);
  });
  console.log(`[CONN] Client connected: ${socket.id}`);
  peers.set(socket.id, {
    socket,
    userId:   null,
    feedId:   null,
    guestId:  null,
    guestProfileUserId: null,
    name:     null,
    kind:     "guest",
    productionId: null,
    consumers: new Map(),
    producers: new Map(),
    activeTalkTargets: [],
    pttTalking: false,
    pttStartedAt: 0,
    connectedAt: null,
  });

  // Emit lists
  socket.emit("conference-list", getAllConferences());

  socket.on("media-network-stats", (payload = {}) => {
    const peer = peers.get(socket.id);
    if (!peer || peer.isBridgePeer || (peer.kind !== "user" && peer.kind !== "feed")) return;

    const stats = normalizeBrowserMediaStats(payload);
    if (!stats) return;
    logBrowserMediaStats(peer, socket.id, stats);
    peer.browserMediaStats = {
      ...stats,
      reportedAt: Date.now(),
    };
    scheduleAdminStatusBroadcast("browser-media-stats-updated");
  });

  socket.on("media-transport-event", (payload = {}) => {
    const peer = peers.get(socket.id);
    if (updatePeerMediaTransportStatus(peer, payload)) {
      scheduleAdminStatusBroadcast("client-media-state-updated");
    }
    const direction = ["send", "receive"].includes(payload?.direction) ? payload.direction : "unknown";
    const event = String(payload?.event || "unknown").slice(0, 80);
    const state = String(payload?.state || "unknown").slice(0, 80);
    const detail = typeof payload?.detail === "string" ? payload.detail.trim().slice(0, 500) : "";
    const label = `${peer?.kind || "client"}:${peer?.userId ?? peer?.feedId ?? peer?.name ?? socket.id}`;
    console.log(
      `[MEDIA][WEBRTC][TRANSPORT] ${new Date().toISOString()} ${label} socket=${socket.id} `
      + `direction=${direction} event=${event} state=${state}`
      + (detail ? ` detail=${JSON.stringify(detail)}` : "")
    );
  });

  socket.on("register-user", ({ id, name, kind = "user", force = false, guestProfileUserId = null, productionId = null, clientType = null } = {}, callback) => {
    const peer = peers.get(socket.id);
    if (!peer) {
      if (typeof callback === "function") callback({ error: "Peer not registered" });
      return;
    }

    const normalizedKind = kind === "feed" ? "feed" : kind === "guest" ? "guest" : "user";
    const numericId = Number(id);
    let effectiveId = Number.isFinite(numericId) ? numericId : id;
    let effectiveName = name;

    if (normalizedKind === "user" || normalizedKind === "feed") {
      const browserSession = getBrowserSessionFromCookieHeader(socket.handshake?.headers?.cookie || "");
      const expectedKind = browserSession?.session?.kind;
      const expectedId = normalizedKind === "user"
        ? browserSession?.session?.userId
        : browserSession?.session?.feedId;
      const browserSessionMatches = expectedKind === normalizedKind
        && String(expectedId) === String(effectiveId);
      const companionAuth = resolveCompanionAuth(extractCompanionApiKeyFromSocket(socket));
      const apiCredentialMatches = !!companionAuth && (
        companionAuth.type === "api-key"
        || (
          normalizedKind === "user"
          && companionAuth.userId != null
          && String(companionAuth.userId) === String(effectiveId)
        )
      );
      if (!browserSessionMatches && !apiCredentialMatches) {
        if (typeof callback === "function") {
          callback({ error: "Authenticated identity does not match registration" });
        }
        return;
      }

      const identity = normalizedKind === "user"
        ? getUserById(effectiveId)
        : getFeedById(effectiveId);
      if (!identity || (normalizedKind === "user" && identity.is_guest_profile)) {
        if (typeof callback === "function") callback({ error: "Authenticated account no longer exists" });
        return;
      }
      effectiveId = identity.id;
      effectiveName = identity.name;
    }

    let activeProductionId = null;
    try {
      if (normalizedKind === "user") {
        const panelSettings = getUserPanelSettings(effectiveId);
        const pendingProductionId = panelSettings.pendingProductionId;
        activeProductionId = normalizeActiveProductionId(pendingProductionId ?? productionId, effectiveId);
      } else if (normalizedKind === "guest") {
        const guestSettings = resolveGuestLoginSettings(loadRuntimeConfig() || {}, { createProfile: false });
        activeProductionId = normalizeActiveProductionId(productionId, guestSettings.profileUserId);
      }
    } catch (error) {
      if (typeof callback === "function") callback({ error: error.message || "Production access denied" });
      return;
    }

    if (normalizedKind === "user") {
      const existing = Array.from(peers.entries()).find(([sid, p]) => (
        sid !== socket.id
        && p?.kind === "user"
        && p?.userId != null
        && String(p.userId) === String(effectiveId)
      ));

      if (existing) {
        const [existingSocketId, existingPeer] = existing;
        if (!force) {
          if (typeof callback === "function") {
            callback({
              conflict: true,
              existing: {
                socketId: existingSocketId,
                name: existingPeer?.name || null,
              },
            });
          }
          return;
        }

        try {
          existingPeer?.socket?.emit("session-kicked", {
            reason: "duplicate-login",
            bySocketId: socket.id,
          });
        } catch {}
        try {
          existingPeer?.socket?.disconnect(true);
        } catch {}
      }

      peer.name = effectiveName;
      peer.kind = normalizedKind;
      peer.userId = effectiveId;
      peer.feedId = null;
      peer.guestId = null;
      peer.guestProfileUserId = null;
      peer.productionId = activeProductionId;
      const savedPanelSettings = getUserPanelSettings(effectiveId);
      if (savedPanelSettings.pendingProductionId) {
        delete savedPanelSettings.pendingProductionId;
        updateUserPanelSettings(effectiveId, savedPanelSettings);
      }
      console.log(`[USER] Registered operator ${effectiveName} (${effectiveId}) on socket ${socket.id}`);
      emitPeerTallyState(peer);
    } else if (normalizedKind === "feed") {
      const existingFeed = Array.from(peers.entries()).find(([sid, p]) => (
        sid !== socket.id
        && p?.kind === "feed"
        && p?.feedId != null
        && String(p.feedId) === String(effectiveId)
      ));

      if (existingFeed) {
        const [, existingPeer] = existingFeed;
        try {
          existingPeer?.socket?.emit("session-kicked", {
            reason: "duplicate-feed-login",
            bySocketId: socket.id,
          });
        } catch {}
        try {
          existingPeer?.socket?.disconnect(true);
        } catch {}
      }

      peer.name = effectiveName;
      peer.kind = normalizedKind;
      peer.feedId = effectiveId;
      peer.userId = null;
      peer.guestId = null;
      peer.guestProfileUserId = null;
      peer.productionId = null;
      console.log(`[USER] Registered feed ${effectiveName} (${effectiveId}) on socket ${socket.id}`);
    } else {
      const settings = resolveGuestLoginSettings(loadRuntimeConfig() || {}, { createProfile: false });
      const requestedProfileId = Number(guestProfileUserId);
      if (!settings.enabled || !settings.profileUserId) {
        if (typeof callback === "function") callback({ error: "Guest login is disabled" });
        return;
      }
      if (Number.isFinite(requestedProfileId) && Number(requestedProfileId) !== Number(settings.profileUserId)) {
        if (typeof callback === "function") callback({ error: "Invalid guest profile" });
        return;
      }
      const guestId = String(id || crypto.randomUUID()).trim();
      peer.name = normalizeGuestDisplayName(name) || settings.profileName || "Guest";
      peer.kind = "guest";
      peer.userId = null;
      peer.feedId = null;
      peer.guestId = guestId;
      peer.guestProfileUserId = settings.profileUserId;
      peer.productionId = activeProductionId;
      console.log(`[USER] Registered guest ${peer.name} (${guestId}) on socket ${socket.id}`);
    }

    peer.connectedAt = Date.now();
    peer.clientType = normalizeRegisteredClientType(clientType);
    emitUserListToOperators();

    if (normalizedKind === "user" && peer.userId !== null && peer.userId !== undefined) {
      updateUserLastOnline(peer.userId);
      const persistedTargetAudioStates = getUserTargetAudioStates(peer.userId);
      updateCompanionUserState(peer.userId, {
        userName: peer.name || null,
        online: true,
        socketId: socket.id,
        targetAudioStates: persistedTargetAudioStates,
      }, {
        reason: "user-online",
        fallbackName: peer.name || null,
      });
      syncPeerCompanionState(peer, { reason: "register-user" });
    }

    if (normalizedKind === "user") {
      broadcastRuntimeUserStates("register-user");
    }

    if (normalizedKind === "feed") {
      socket.emit("conference-list", []);
    } else {
      socket.emit("conference-list", getEffectiveConferencesForPeer(peer));
    }

    if (typeof callback === "function") {
      const profileUserId = normalizedKind === "guest" ? peer.guestProfileUserId : peer.userId;
      callback({
        ok: true,
        allowTargetRearrange: normalizedKind === 'user' && isTargetRearrangeAllowed(getUserById(peer.userId)),
        productionId: peer.productionId ?? null,
        productions: profileUserId == null
          ? []
          : getEnabledProductionsForUser(profileUserId).map(({ id, name: productionName }) => ({
            id,
            name: productionName,
          })),
        targetAudioStates: normalizedKind === "user" && peer.userId != null
          ? getUserTargetAudioStates(peer.userId)
          : [],
        panelSettings: normalizedKind === 'user' && peer.userId != null
          ? remotePanels.savedSettings(peer.userId) : null,
        userAudioSettings: normalizedKind === "user" && peer.userId != null
          && Object.keys(getUserAudioSettings(peer.userId) || {}).length
          ? getResolvedUserAudioSettings(peer.userId)
          : null,
      });
    }
  });

  socket.on("set-active-production", ({ productionId = null } = {}, callback = () => {}) => {
    const peer = peers.get(socket.id);
    if (!isOperatorPeer(peer)) {
      callback({ ok: false, error: "Peer not registered" });
      return;
    }
    const userId = peer.kind === "guest" ? peer.guestProfileUserId : peer.userId;
    try {
      peer.productionId = normalizeActiveProductionId(productionId, userId);
      emitPeerTallyState(peer);
      socket.emit("conference-list", getEffectiveConferencesForPeer(peer));
      socket.emit("conference-members-updated", { conferenceId: null });
      reconcileAllProducerRecipients({ forceAnnounce: true });
      broadcastRuntimeUserStates("active-production-changed");
      callback({ ok: true, productionId: peer.productionId });
    } catch (error) {
      callback({ ok: false, error: error.message || "Production access denied" });
    }
  });

  socket.on('panel-client-state', (payload = {}) => {
    remotePanels.report(peers.get(socket.id), payload);
  });

  socket.on("target-audio-state-snapshot", ({ reason = "target-audio-state", states = [], revision = 0 } = {}) => {
    const peer = peers.get(socket.id);
    if (!peer || peer.kind !== "user" || peer.userId === null || peer.userId === undefined) {
      return;
    }

    if (Number(revision) !== remotePanels.savedSettings(peer.userId).revision) return;
    mergeUserTargetAudioStates(peer.userId, states);
    updateCompanionUserState(peer.userId, {
      userName: peer.name || null,
      targetAudioStates: getUserTargetAudioStates(peer.userId),
    }, {
      reason,
      fallbackName: peer.name || null,
    });
  });

  socket.on('user-audio-settings-update', ({ settings, revision = 0 } = {}, callback = () => {}) => {
    const peer = peers.get(socket.id);
    if (!peer || peer.kind !== 'user' || peer.userId == null) {
      return callback({ ok: false, error: 'Peer not registered' });
    }
    try {
      if (Number(revision) !== remotePanels.savedSettings(peer.userId).revision) {
        return callback({ ok: false, error: 'Client settings changed remotely' });
      }
      const normalized = normalizeUserAudioSettings(settings, { strict: true });
      updateUserAudioSettings(peer.userId, normalized);
      callback({ ok: true, settings: getResolvedUserAudioSettings(peer.userId) });
    } catch (error) {
      callback({ ok: false, error: error.message || 'Invalid audio settings' });
    }
  });

  socket.on("ptt-state", (payload = {}) => {
    const peer = peers.get(socket.id);
    if (!isOperatorPeer(peer)) {
      return;
    }
    if (!isPersistentUserPeer(peer)) {
      return;
    }

    const patch = {
      userName: peer.name || null,
      online: true,
      socketId: socket.id,
    };

    if (typeof payload.lockActive === "boolean") {
      patch.talkLocked = payload.lockActive;
    }

    const normalizedTargets = normalizeRuntimeTalkTargets(payload.targets);
    const wasTalking = Boolean(peer.pttTalking);
    peer.pttTalking = Boolean(payload.talking && normalizedTargets.length > 0);
    if (peer.pttTalking) {
      peer.activeTalkTargets = normalizedTargets;
      if (!wasTalking) {
        peer.pttStartedAt = Date.now();
      }
    } else {
      peer.pttStartedAt = 0;
    }

    if (normalizedTargets.length > 0) {
      patch.lastTargets = normalizedTargets;
    }

    const normalizedTarget = normalizeRuntimeTalkTarget(payload.target);
    if (normalizedTarget) {
      patch.lastTarget = normalizedTarget;
    } else if (normalizedTargets.length > 0) {
      patch.lastTarget = normalizedTargets[0];
    }

    updateCompanionUserState(peer.userId, patch, {
      reason: "ptt-state",
      fallbackName: peer.name || null,
    });
    broadcastRuntimeUserStates("ptt-state");
  });

  socket.on("talk-targets-updated", (payload = {}) => {
    const peer = peers.get(socket.id);
    if (!isOperatorPeer(peer)) {
      return;
    }

    const normalizedTargets = normalizeRuntimeTalkTargets(payload.targets);
    peer.activeTalkTargets = normalizedTargets;

    if (isPersistentUserPeer(peer)) {
      const patch = {
        userName: peer.name || null,
        online: true,
        socketId: socket.id,
      };
      if (normalizedTargets.length > 0) {
        patch.lastTarget = normalizedTargets[0];
        patch.lastTargets = normalizedTargets;
      }

      updateCompanionUserState(peer.userId, patch, {
        reason: "talk-targets-updated",
        fallbackName: peer.name || null,
      });
    }

    const talkProducers = getPeerTalkProducers(peer, { includePaused: true }).filter((producer) => (
      String(producer?.appData?.type || "").trim().toLowerCase() === "talk"
    ));
    if (talkProducers.length === 0) {
      return;
    }

    if (normalizedTargets.length > 0) {
      talkProducers.forEach((producer) => {
        syncProducerRecipients({ producer, speakerSocketId: socket.id });
      });
    }

    syncPeerCompanionState(peer, { reason: "talk-targets-updated" });
    broadcastRuntimeUserStates("talk-targets-updated");
  });

  const handleApiCommandResult = (payload = {}) => {
    const peer = peers.get(socket.id);
    if (!peer || peer.kind !== "user" || peer.userId === null || peer.userId === undefined) {
      return;
    }

    const commandId = typeof payload.commandId === "string" ? payload.commandId : null;
    if (!commandId) return;

    const resultPayload = {
      commandId,
      userId: peer.userId,
      userName: peer.name || null,
      socketId: socket.id,
      ok: Boolean(payload.ok),
      action: payload.action || null,
      targetType: payload.targetType || null,
      targetId: payload.targetId ?? null,
      reason: payload.reason || null,
      at: new Date().toISOString(),
    };

    const normalizedTarget = normalizeRuntimeTalkTarget(payload.target);
    const patch = {
      userName: peer.name || null,
      lastCommandId: commandId,
      lastCommandResult: resultPayload.ok ? "ok" : (resultPayload.reason || "failed"),
    };
    if (typeof payload.lockActive === "boolean") {
      patch.talkLocked = payload.lockActive;
    }
    const normalizedTargets = normalizeRuntimeTalkTargets(payload.targets);
    if (normalizedTargets.length > 0) {
      patch.lastTargets = normalizedTargets;
    }
    if (normalizedTarget) {
      patch.lastTarget = normalizedTarget;
    } else if (normalizedTargets.length > 0) {
      patch.lastTarget = normalizedTargets[0];
    }
    updateCompanionUserState(peer.userId, patch, {
      reason: "command-result",
      fallbackName: peer.name || null,
    });

    resultPayload.state = buildCompanionUserState(peer.userId, peer.name || null);
    settleCompanionPendingCommand(commandId, resultPayload);
    emitCompanionEvent("command-result", resultPayload);
  };

  socket.on("api-talk-command-result", handleApiCommandResult);
  socket.on("api-target-audio-command-result", handleApiCommandResult);

  // ---- LinkTalk: подслушка (мониторинг) ----
  const describeMonitorsFor = (userId) => monitoring.describeMonitorsForUser({
    userId,
    links: ns.monitorCache.monitorLinks,
    nameOfUser: (id) => getUserById(id)?.name || null,
  });

  socket.on("monitor-get", (callback = () => {}) => {
    const peer = peers.get(socket.id);
    if (typeof callback !== "function") return;
    if (!isPersistentUserPeer(peer)) {
      callback({ monitors: [] });
      return;
    }
    callback({ monitors: describeMonitorsFor(Number(peer.userId)) });
  });

  socket.on("monitor-set", ({ targetUserId, enabled } = {}, callback = () => {}) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const peer = peers.get(socket.id);
    if (!isPersistentUserPeer(peer)) {
      reply({ error: "Not signed in as a user" });
      return;
    }
    const userId = Number(peer.userId);
    let changed = false;
    try {
      changed = setMonitorEnabled(userId, Number(targetUserId), Boolean(enabled));
    } catch (error) {
      reply({ error: error?.message || "Could not change monitoring" });
      return;
    }
    if (!changed) {
      reply({ error: "Monitoring is not permitted or is forced by the administrator" });
      return;
    }
    notifyMonitorChange(userId);
    reply({ ok: true, monitors: describeMonitorsFor(userId) });
  });

  socket.on("request-active-producers", (callback = () => {}) => {
    const peer = peers.get(socket.id);
    if (!isOperatorPeer(peer)) {
      return callback([]);
    }

    const response = [];
    let conferenceIds = null;
    let feedIds = null;

    const loadConferenceIds = () => {
      if (conferenceIds !== null) {
        return conferenceIds;
      }
      const memberships = getEffectiveConferencesForPeer(peer);
      conferenceIds = new Set(
        memberships.map((conf) => String(conf.id))
      );
      return conferenceIds;
    };

    const loadFeedIds = () => {
      if (feedIds !== null) {
        return feedIds;
      }
      feedIds = new Set(getEffectiveFeedIdsForPeer(peer).map((id) => String(id)));
      return feedIds;
    };

    for (const [otherSocketId, otherPeer] of peers) {
      if (otherSocketId === socket.id) continue;

      for (const [producerId, producer] of otherPeer.producers) {
        if (!producer || producer.closed) continue;
        const appData = producer?.appData;
        if (!appData || typeof appData !== "object") continue;
        const type = String(appData.type || "").trim().toLowerCase();
        let activeDelivery = null;

        if (!producer.paused && type === "feed") {
          const feedId = appData.id;
          if (feedId == null) continue;
          const membership = loadFeedIds();
          if (membership.has(String(feedId))) {
            activeDelivery = { recipientSocketId: socket.id, appData };
          }
        } else if (!producer.paused && type === "conference") {
          const confId = appData.id;
          if (confId == null) continue;
          const membership = loadConferenceIds();
          if (membership.has(String(confId))) {
            activeDelivery = { recipientSocketId: socket.id, appData };
          }
        } else if (!producer.paused && (type === "user" || type === "talk")) {
          const deliveries = resolveProducerRecipientDeliveries({ appData, speakerSocketId: otherSocketId });
          activeDelivery = deliveries.find((candidate) => candidate.recipientSocketId === socket.id) || null;
        } else if (!producer.paused && type === "guest") {
          const deliveries = resolveProducerRecipientDeliveries({ appData, speakerSocketId: otherSocketId });
          activeDelivery = deliveries.find((candidate) => candidate.recipientSocketId === socket.id) || null;
        }

        const reconciliationDelivery = resolveProducerReconciliationDelivery({
          producer,
          recipientSocketId: socket.id,
          activeDelivery,
        });
        if (!reconciliationDelivery?.appData) continue;
        response.push({
          peerId: otherSocketId,
          speakerUserId: otherPeer?.userId ?? null,
          producerId,
          appData: reconciliationDelivery.appData,
          retainOnly: Boolean(reconciliationDelivery.retainOnly),
        });
      }
    }

    callback(response);
  });

  socket.on("user-logout", (callback = () => {}) => {
    try {
      callback({ ok: true });
    } catch {}
    disconnectUserPeerForLogout({ socketId: socket.id });
  });

  socket.on("producer-close", ({ producerId } = {}, callback = () => {}) => {
    console.log(
        `[SIGNAL] producer-close received from client ${socket.id} for producer ${producerId}`
    );

    const peer     = peers.get(socket.id);
    const producer = peer?.producers.get(producerId);
    if (!producer) {
      console.warn(`[SIGNAL] No producer found with ID ${producerId}.`);
      callback({ ok: false, error: "Producer not found" });
      return;
    }

    // Read the appData so the client knows which tile it was
    const { appData } = producer;

    // 2. Close the producer and clean up internal state
    producer.close();
    peer.producers.delete(producerId);
    syncPeerCompanionState(peer, { reason: "producer-close" });
    broadcastRuntimeUserStates("producer-close");

    // 3. Broadcast to all other clients immediately, including appData
    socket.broadcast.emit("producer-closed", {
      peerId:     socket.id,
      speakerUserId: peer?.userId ?? null,
      producerId,
      appData
    });

    console.log(`[SIGNAL] producer-closed an alle anderen gesendet`);
    callback({ ok: true });
  });

  socket.on("pause-producer", async ({ producerId } = {}, callback = () => {}) => {
    const peer = peers.get(socket.id);
    const producer = peer?.producers.get(producerId);
    if (!producer) {
      callback({ error: "Producer not found" });
      return;
    }

    try {
      await producer.pause();
      console.log(
        `[SIGNAL] pause-producer ok socket=${socket.id} user=${peer.userId ?? peer.guestProfileUserId ?? "unknown"} `
        + `producer=${producer.id} type=${producer.appData?.type || "unknown"}`
      );
      callback({ ok: true });
    } catch (error) {
      console.error("[SIGNAL] pause-producer failed:", error);
      callback({ error: error?.message || "pause-producer failed" });
    }
  });

  socket.on("resume-producer", async ({ producerId } = {}, callback = () => {}) => {
    const peer = peers.get(socket.id);
    const producer = peer?.producers.get(producerId);
    if (!producer) {
      callback({ error: "Producer not found" });
      return;
    }

    try {
      await producer.resume();
      console.log(
        `[SIGNAL] resume-producer ok socket=${socket.id} user=${peer.userId ?? peer.guestProfileUserId ?? "unknown"} `
        + `producer=${producer.id} type=${producer.appData?.type || "unknown"}`
      );
      callback({ ok: true });
    } catch (error) {
      console.error("[SIGNAL] resume-producer failed:", error);
      callback({ error: error?.message || "resume-producer failed" });
    }
  });


  socket.on("register-name", (name) => {
    const peer = peers.get(socket.id);
    if (peer) {
      peer.name = name;
      console.log(`[USER] Registered name for ${socket.id}: ${name}`);

      if (peer.kind === "user" && peer.userId !== null && peer.userId !== undefined) {
        updateCompanionUserState(peer.userId, {
          userName: peer.name || null,
          online: true,
          socketId: socket.id,
        }, {
          reason: "register-name",
          fallbackName: peer.name || null,
        });
      }

      // Send the updated list afterwards
      emitUserListToOperators();
      if (peer.kind === "user" && peer.userId !== null && peer.userId !== undefined) {
        broadcastRuntimeUserStates("register-name");
      }
    }
  });

  // Send RTP capabilities on request
  socket.on("get-router-rtp-capabilities", (callback) => {
    if (!ns.bridgeControl.router) {
      console.warn("[RTP] Router not ready yet – rejecting request");
      return callback({ error: "Router not initialized, try again" });
    }
    callback(ns.bridgeControl.router.rtpCapabilities);
  });

  socket.on("create-send-transport", async (_, callback) => {
    console.log(`[TRANSPORT] Client ${socket.id} requests send transport`);
    try {
      if (!ns.bridgeControl.router) {
        return callback({ error: "Media router is not ready, try again" });
      }
      const mediaRoute = resolveTransportAnnouncedAddress();
      if (mediaRoute.error || !mediaRoute.announcedAddress) {
        console.error("[TRANSPORT] No usable announced IP:", mediaRoute.error || "unknown media network error");
        return callback({ error: mediaRoute.error || "No usable announced IP available" });
      }

      if (mediaRoute.mode === "auto" && mediaRoute.interfaceName) {
        console.log(`[TRANSPORT] Auto-detected RTC addresses: ${getActiveRtcAddresses(mediaRoute).join(", ")}`);
      } else if (mediaRoute.mode === "interface") {
        console.log(`[TRANSPORT] Using selected interfaces: ${mediaRoute.interfaceName}`);
      }
      console.log(`[TRANSPORT] Offering RTC address(es): ${getActiveRtcAddresses(mediaRoute).join(", ")}`);
      warnIfDockerAnnouncedIpLooksInternal(mediaRoute.announcedAddress);

      const transport = await ns.bridgeControl.router.createWebRtcTransport({
        listenInfos: buildWebRtcListenInfos({ mediaRoute, env: process.env }),
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        // Additional debugging
        enableSctp: false,
        numSctpStreams: { OS: 0, MIS: 0 },
        initialAvailableOutgoingBitrate: 600000,
      });

      peers.get(socket.id).sendTransport = transport;
      resetPeerMediaTransportStatus(peers.get(socket.id), "send");
      attachWebRtcTransportDiagnostics(socket.id, "send", transport);
      scheduleAdminStatusBroadcast("send-transport-created");
      console.log(`[TRANSPORT] Send transport created: ${transport.id}`);
      console.log(`[TRANSPORT] ICE Candidates:`, transport.iceCandidates);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        ...CLIENT_ICE_CONFIG,
      });
    } catch (error) {
      console.error("[TRANSPORT] Error creating send transport:", error);
      callback({ error: error.message });
    }
  });

  socket.on("create-recv-transport", async (_, callback) => {
    console.log(`[TRANSPORT] Client ${socket.id} requests recv transport`);
    try {
      if (!ns.bridgeControl.router) {
        return callback({ error: "Media router is not ready, try again" });
      }
      const mediaRoute = resolveTransportAnnouncedAddress();
      if (mediaRoute.error || !mediaRoute.announcedAddress) {
        console.error("[TRANSPORT] No usable announced IP:", mediaRoute.error || "unknown media network error");
        return callback({ error: mediaRoute.error || "No usable announced IP available" });
      }

      if (mediaRoute.mode === "auto" && mediaRoute.interfaceName) {
        console.log(`[TRANSPORT] Auto-detected RTC addresses: ${getActiveRtcAddresses(mediaRoute).join(", ")}`);
      } else if (mediaRoute.mode === "interface") {
        console.log(`[TRANSPORT] Using selected interfaces: ${mediaRoute.interfaceName}`);
      }
      console.log(`[TRANSPORT] Offering RTC address(es): ${getActiveRtcAddresses(mediaRoute).join(", ")}`);
      warnIfDockerAnnouncedIpLooksInternal(mediaRoute.announcedAddress);

      const transport = await ns.bridgeControl.router.createWebRtcTransport({
        listenInfos: buildWebRtcListenInfos({ mediaRoute, env: process.env }),
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        enableSctp: false,
        numSctpStreams: { OS: 0, MIS: 0 },
        initialAvailableOutgoingBitrate: 600000,
      });

      peers.get(socket.id).recvTransport = transport;
      resetPeerMediaTransportStatus(peers.get(socket.id), "receive");
      attachWebRtcTransportDiagnostics(socket.id, "receive", transport);
      scheduleAdminStatusBroadcast("receive-transport-created");
      console.log(`[TRANSPORT] Recv transport created: ${transport.id}`);
      console.log(`[TRANSPORT] ICE Candidates:`, transport.iceCandidates);

      callback({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        ...CLIENT_ICE_CONFIG,
      });
    } catch (error) {
      console.error("[TRANSPORT] Error creating recv transport:", error);
      callback({ error: error.message });
    }
  });

  socket.on("connect-send-transport", async ({ dtlsParameters }, callback) => {
    console.log(`[CONNECT] Client ${socket.id} connecting send transport`);
    try {
      const transport = peers.get(socket.id).sendTransport;
      await transport.connect({ dtlsParameters });
      console.log(`[CONNECT] Send transport connected for ${socket.id}`);
      callback();
    } catch (error) {
      console.error("[CONNECT] Error:", error);
      callback({ error: error.message });
    }
  });

  socket.on("connect-recv-transport", async ({ dtlsParameters }, callback) => {
    console.log(`[CONNECT] Client ${socket.id} connecting recv transport`);
    try {
      const transport = peers.get(socket.id).recvTransport;
      await transport.connect({ dtlsParameters });
      console.log(`[CONNECT] Recv transport connected for ${socket.id}`);
      callback();
    } catch (error) {
      console.error("[CONNECT] Error:", error);
      callback({ error: error.message });
    }
  });

  socket.on("create-plain-send-transport", async (_, callback = () => {}) => {
    console.log(`[GATEWAY] Client ${socket.id} requests plain send transport`);
    try {
      if (!ns.bridgeControl.router) {
        return callback({ error: "Router not initialized, try again" });
      }

      const peer = peers.get(socket.id);
      if (!peer) {
        return callback({ error: "Peer not registered" });
      }

      const mediaRoute = resolveTransportAnnouncedAddress();
      if (mediaRoute.error || !mediaRoute.announcedAddress) {
        console.error("[GATEWAY] No usable announced IP:", mediaRoute.error || "unknown media network error");
        return callback({ error: mediaRoute.error || "No usable announced IP available" });
      }
      const mediaAddress = selectMediaRouteAddress(
        mediaRoute,
        socket.request?.socket?.localAddress || socket.conn?.transport?.socket?.localAddress
      );

      if (peer.plainSendTransport && !peer.plainSendTransport.closed) {
        try {
          peer.plainSendTransport.close();
        } catch {}
      }

      const transport = await ns.bridgeControl.router.createPlainTransport({
        listenIp: {
          ip: "0.0.0.0",
          announcedIp: mediaAddress,
        },
        rtcpMux: true,
        comedia: true,
      });

      peer.plainSendTransport = transport;
      transport.observer.on("close", () => {
        if (peer.plainSendTransport === transport) {
          peer.plainSendTransport = null;
        }
      });

      callback({
        id: transport.id,
        ip: mediaAddress,
        port: transport.tuple.localPort,
        protocol: transport.tuple.protocol,
        rtcpMux: true,
        comedia: true,
        payloadType: GATEWAY_OPUS_PAYLOAD_TYPE,
        ssrc: GATEWAY_OPUS_SSRC,
      });
    } catch (error) {
      console.error("[GATEWAY] Error creating plain send transport:", error);
      callback({ error: error.message });
    }
  });

  socket.on("produce-plain", async ({ kind = "audio", appData, rtpParameters } = {}, callback = () => {}) => {
    console.log(`[GATEWAY] Client ${socket.id} wants to produce plain ${kind}`, appData);
    try {
      const peer = peers.get(socket.id);
      if (!peer) {
        return callback({ error: "Peer not registered" });
      }

      const transport = peer.plainSendTransport;
      if (!transport || transport.closed) {
        return callback({ error: "Plain send transport not ready" });
      }

      const { type, id: targetId } = appData || {};
      const validTypes = ["talk", "user", "conference", "guest", "feed"];
      const requiresTargetId = type !== "talk";
      if (!type || !validTypes.includes(type) || (requiresTargetId && !targetId)) {
        return callback({
          error: "Invalid appData: expected routing metadata for talk, user, conference, guest, or feed.",
        });
      }

      if (peer.kind === "feed") {
        if (type !== "feed" || peer.feedId === null || String(peer.feedId) !== String(targetId)) {
          return callback({ error: "Feeds can only produce their assigned feed" });
        }
      }

      const existingPlainProducers = Array.from(peer.producers.values()).filter((existingProducer) => (
        existingProducer?.appData?.type === type
        && String(existingProducer?.appData?.id) === String(targetId)
      ));
      for (const existingProducer of existingPlainProducers) {
        try {
          existingProducer.close();
        } catch (closeError) {
          console.warn(`[GATEWAY] Failed to close previous plain producer ${existingProducer?.id}:`, closeError);
        }
      }

      const producer = await transport.produce({
        kind,
        rtpParameters: rtpParameters || buildGatewayAudioRtpParameters(),
        appData,
      });
      attachProducerMediaDiagnostics(producer, `plain:${peer.kind}:${peer.userId ?? peer.feedId ?? socket.id}`);

      producer.__startedAt = Date.now();
      peer.producers.set(producer.id, producer);
      syncPeerCompanionState(peer, { reason: "plain-produce-started" });
      broadcastRuntimeUserStates("plain-produce-started");

      callback({ id: producer.id });

      announceProducerToRecipients({
        producerId: producer.id,
        appData,
        speakerSocketId: socket.id,
      });

      producer.observer.on("pause", () => {
        syncPeerCompanionState(peer, { reason: "plain-produce-paused" });
        broadcastRuntimeUserStates("plain-produce-paused");
      });

      producer.observer.on("resume", () => {
        producer.__startedAt = Date.now();
        syncPeerCompanionState(peer, { reason: "plain-produce-resumed" });
        broadcastRuntimeUserStates("plain-produce-resumed");
        announceProducerToRecipients({
          producerId: producer.id,
          appData,
          speakerSocketId: socket.id,
          forceAnnounce: true,
        });
      });

      producer.on("close", () => {
        peer.producers.delete(producer.id);
        syncPeerCompanionState(peer, { reason: "plain-produce-closed" });
        broadcastRuntimeUserStates("plain-produce-closed");
        socket.broadcast.emit("producer-closed", {
          peerId: socket.id,
          speakerUserId: peer?.userId ?? null,
          producerId: producer.id,
          appData,
        });
      });

      producer.on("transportclose", () => {
        peer.producers.delete(producer.id);
        syncPeerCompanionState(peer, { reason: "plain-produce-transport-closed" });
        broadcastRuntimeUserStates("plain-produce-transport-closed");
      });
    } catch (error) {
      console.error("[GATEWAY] Plain produce error:", error);
      callback({ error: error.message });
    }
  });

  socket.on("consume-plain", async ({ producerId, ip, port, rtpCapabilities } = {}, callback = () => {}) => {
    console.log(`[GATEWAY] Client ${socket.id} wants plain consume producer ${producerId} to ${ip}:${port}`);
    try {
      if (!ns.bridgeControl.router) {
        return callback({ error: "Router not initialized, try again" });
      }

      const peer = peers.get(socket.id);
      if (!peer) {
        return callback({ error: "Peer not registered" });
      }

      const targetIp = String(ip || "").trim();
      const targetPort = Number(port);
      if (!targetIp || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        return callback({ error: "Invalid plain consume target ip/port" });
      }

      let producerPeer = null;
      for (const [peerId, candidatePeer] of peers) {
        if (candidatePeer.producers.has(producerId)) {
          producerPeer = peerId;
          break;
        }
      }
      if (!producerPeer) {
        return callback({ error: "Producer not found" });
      }

      const capabilities = rtpCapabilities || ns.bridgeControl.router.rtpCapabilities;
      if (!ns.bridgeControl.router.canConsume({ producerId, rtpCapabilities: capabilities })) {
        return callback({ error: "Cannot consume" });
      }

      const transport = await ns.bridgeControl.router.createPlainTransport({
        listenIp: { ip: "0.0.0.0" },
        rtcpMux: true,
        comedia: false,
      });
      await transport.connect({ ip: targetIp, port: targetPort });

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: capabilities,
        paused: true,
      });
      consumer.__plainTransport = transport;
      peer.consumers.set(consumer.id, consumer);

      const cleanup = () => {
        peer.consumers.delete(consumer.id);
        try {
          if (!transport.closed) transport.close();
        } catch {}
      };

      consumer.on("transportclose", cleanup);
      consumer.on("producerclose", () => {
        cleanup();
        socket.emit("consumer-closed", { consumerId: consumer.id, producerId });
      });

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error) {
      console.error("[GATEWAY] Plain consume error:", error);
      callback({ error: error.message });
    }
  });

  socket.on(
      "produce",
      async ({ kind, rtpParameters, appData }, callback) => {
        console.log(
            `[PRODUCE] Client ${socket.id} wants to produce ${kind}`,
            appData
        );

        //------------------------------------------------------------------
        // 0️⃣  Validate incoming data
        //------------------------------------------------------------------
        const { type, id: targetId } = appData || {};
        const validTypes = ["talk", "user", "conference", "guest", "feed"];
        const requiresTargetId = type !== "talk";

        if (
            !type ||
            !validTypes.includes(type) ||
            (requiresTargetId && !targetId)
        ) {
          console.warn("[PRODUCE] Invalid appData:", appData);
          return callback({
            error:
                "Invalid appData: For 'talk', 'user', 'conference', 'guest', or 'feed', valid routing metadata must be provided.",
          });
        }

        try {
          //----------------------------------------------------------------
          // 1️⃣  Create the producer
          //----------------------------------------------------------------
          const peer = peers.get(socket.id);
          if (!peer) {
            return callback({ error: "Peer not registered" });
          }

          if (type === "feed") {
            if (
              peer.kind !== "feed" ||
              peer.feedId === null ||
              String(peer.feedId) !== String(targetId)
            ) {
              console.warn(`[PRODUCE] Peer ${socket.id} is not authorized to produce for feed ${targetId}`);
              return callback({ error: "Not authorized to produce for this feed" });
            }
          } else if (peer.kind === "feed") {
            console.warn(`[PRODUCE] Feed peer ${socket.id} tried to produce for type ${type}`);
            return callback({ error: "Feeds can only produce their assigned feed" });
          }

          const transport = peer.sendTransport;
          if (!transport) {
            console.warn(`[PRODUCE] No send transport for peer ${socket.id}`);
            return callback({ error: "Send transport not ready" });
          }

          if (type === "feed") {
            const existingFeedProducers = Array.from(peer.producers.values()).filter((existingProducer) => (
              existingProducer?.appData?.type === "feed"
              && String(existingProducer?.appData?.id) === String(targetId)
            ));
            for (const existingProducer of existingFeedProducers) {
              try {
                existingProducer.close();
              } catch (closeError) {
                console.warn(`[PRODUCE] Failed to close previous feed producer ${existingProducer?.id}:`, closeError);
              }
            }
          }

          const producer = await transport.produce({
            kind,
            rtpParameters,
            appData,
          });
          attachProducerMediaDiagnostics(producer, `webrtc:${peer.kind}:${peer.userId ?? peer.feedId ?? socket.id}`);

          producer.__startedAt = Date.now();
          peer.producers.set(producer.id, producer);
          syncPeerCompanionState(peer, { reason: "produce-started" });
          broadcastRuntimeUserStates("produce-started");
          console.log(
              `[PRODUCE] Producer created: ${producer.id} for ${socket.id}`
          );

          //----------------------------------------------------------------
          // 2️⃣  Send the ID back to the client
          //----------------------------------------------------------------
          callback({ id: producer.id });

          //----------------------------------------------------------------
          // 3️⃣  Routing
          //----------------------------------------------------------------
          const initialRecipientSocketIds = announceProducerToRecipients({
            producerId: producer.id,
            appData,
            speakerSocketId: socket.id,
          });
          console.log(
            `[ROUTE] Announced producer ${producer.id} for ${type} ${targetId ?? ""} `
            + `recipients=${initialRecipientSocketIds.length}`
          );

          //----------------------------------------------------------------
          // 4️⃣  Cleanup listener
          //----------------------------------------------------------------
          producer.appData = appData;  // store once
          producer.observer.on("pause", () => {
            syncPeerCompanionState(peer, { reason: "produce-paused" });
            broadcastRuntimeUserStates("produce-paused");
          });
          producer.observer.on("resume", () => {
            producer.__startedAt = Date.now();
            syncPeerCompanionState(peer, { reason: "produce-resumed" });
            broadcastRuntimeUserStates("produce-resumed");
            const resumedRecipientSocketIds = announceProducerToRecipients({
              producerId: producer.id,
              appData,
              speakerSocketId: socket.id,
              forceAnnounce: true,
            });
            console.log(
              `[ROUTE] Re-announced resumed producer ${producer.id} for ${type} ${targetId ?? ""} `
              + `recipients=${resumedRecipientSocketIds.length}`
            );
          });

          producer.on("close", () => {
            peer.producers.delete(producer.id);
            if (type === "talk" && getPeerActiveTalkProducers(peer).length === 0) {
              peer.activeTalkTargets = [];
            }
            syncPeerCompanionState(peer, { reason: "produce-closed" });
            broadcastRuntimeUserStates("produce-closed");
            socket.broadcast.emit("producer-closed", {
              peerId:     socket.id,
              speakerUserId: peer?.userId ?? null,
              producerId: producer.id,
              appData     // included now
            });
          });


          producer.on("transportclose", () => {
            peer.producers.delete(producer.id);
            if (type === "talk" && getPeerActiveTalkProducers(peer).length === 0) {
              peer.activeTalkTargets = [];
            }
            syncPeerCompanionState(peer, { reason: "produce-transport-closed" });
            broadcastRuntimeUserStates("produce-transport-closed");
          });
        } catch (error) {
          console.error("[PRODUCE] Error:", error);
          callback({ error: error.message });
        }
      }
  );




  socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
    console.log(
      `[CONSUME] Client ${socket.id} wants to consume producer ${producerId}`
    );

    try {
      const peer = peers.get(socket.id);
      if (!peer) {
        return callback({ error: "Peer not registered" });
      }

      // Find the producer
      let producerPeer = null;
      for (const [peerId, peer] of peers) {
        if (peer.producers.has(producerId)) {
          producerPeer = peerId;
          break;
        }
      }

      if (!producerPeer) {
        throw new Error("Producer not found");
      }

      console.log(`[CONSUME] Found producer from peer ${producerPeer}`);

      if (!ns.bridgeControl.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error("Cannot consume");
      }

      const transport = peer.recvTransport;
      if (!transport) {
        return callback({ error: "Receive transport not ready" });
      }

      const existingConsumers = Array.from(peer.consumers.values()).filter((candidate) => (
        candidate
        && !candidate.closed
        && !candidate.__plainTransport
        && String(candidate.producerId || "") === String(producerId)
      ));
      for (const existingConsumer of existingConsumers) {
        console.warn(
          `[CONSUME] Replacing stale duplicate consumer ${existingConsumer.id} for ${socket.id} `
          + `and producer ${producerId}`
        );
        try {
          existingConsumer.close();
        } catch {}
        peer.consumers.delete(existingConsumer.id);
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      peer.consumers.set(consumer.id, consumer);
      console.log(
        `[CONSUME] Consumer created: ${consumer.id} for ${socket.id}`
      );

      consumer.on("transportclose", () => {
        console.log(`[CONSUME] Consumer transport closed for ${consumer.id}`);
        peers.get(socket.id)?.consumers.delete(consumer.id);
      });

      consumer.on("producerclose", () => {
        console.log(`[CONSUME] Producer closed for consumer ${consumer.id}`);
        socket.emit("consumer-closed", { consumerId: consumer.id });
        peers.get(socket.id)?.consumers.delete(consumer.id);
      });

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error) {
      console.error("[CONSUME] Error:", error);
      callback({ error: error.message });
    }
  });

  socket.on("resume-consumer", async ({ consumerId }, callback) => {
    console.log(`[RESUME] Client ${socket.id} resuming consumer ${consumerId}`);
    try {
      const consumer = peers.get(socket.id)?.consumers.get(consumerId);
      if (consumer) {
        await consumer.resume();
        console.log(`[RESUME] Consumer ${consumerId} resumed`);
      }
      callback();
    } catch (error) {
      console.error("[RESUME] Error:", error);
      callback({ error: error.message });
    }
  });

  socket.on("close-consumer", ({ consumerId } = {}, callback = () => {}) => {
    console.log(`[CONSUME] Client ${socket.id} closing consumer ${consumerId}`);
    try {
      const peer = peers.get(socket.id);
      const consumer = peer?.consumers.get(consumerId);
      if (consumer) {
        const plainTransport = consumer.__plainTransport || null;
        try {
          consumer.close();
        } catch {}
        peer.consumers.delete(consumer.id);
        try {
          if (plainTransport && !plainTransport.closed) plainTransport.close();
        } catch {}
      }
      callback({ ok: true });
    } catch (error) {
      console.error("[CONSUME] Close error:", error);
      callback({ error: error.message });
    }
  });

  socket.on("disconnect", (reason) => {
    const peer = peers.get(socket.id);
    console.log(
      `[CONN] Client disconnected: ${socket.id} reason=${JSON.stringify(reason || "unknown")} `
      + `peer=${peer?.kind || "unknown"}:${peer?.userId ?? peer?.feedId ?? peer?.name ?? "unknown"} `
      + `send=${peer?.sendTransport?.connectionState || "none"} `
      + `receive=${peer?.recvTransport?.connectionState || "none"}`
    );
    const disconnectedUserId =
      peer && peer.kind === "user" && peer.userId !== null && peer.userId !== undefined
        ? peer.userId
        : null;
    const disconnectedUserName =
      disconnectedUserId !== null ? (peer?.name || null) : null;

    if (peer) {
      // Close all producers
      for (const producer of peer.producers.values()) {
        producer.close();
      }
      console.log(
        `[CLEANUP] ${peer.producers.size} producers closed for ${socket.id}`
      );

      // Close transports
      if (peer.sendTransport) {
        peer.sendTransport.close();
        console.log(`[CLEANUP] Send transport closed for ${socket.id}`);
      }
      if (peer.recvTransport) {
        peer.recvTransport.close();
        console.log(`[CLEANUP] Recv transport closed for ${socket.id}`);
      }

      // Close consumers
      peer.consumers.forEach((c) => c.close());
      console.log(
        `[CLEANUP] ${peer.consumers.size} consumers closed for ${socket.id}`
      );
    }

    // Remove the peer first so companion state rebuild does not still resolve
    // this socket as online while we emit the offline update.
    peers.delete(socket.id);

    if (disconnectedUserId !== null) {
      const replacementPeer = findUserPeerByUserId(disconnectedUserId);
      if (!replacementPeer) {
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
          reason: "user-offline",
          fallbackName: disconnectedUserName,
        });
        failPendingCommandsForUser(disconnectedUserId, "user-disconnected");
      }
    }

    emitUserListToOperators();
    broadcastRuntimeUserStates("user-disconnected");
  });
});