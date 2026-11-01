/**
 * LinkTalk server — HTTP API моста (announce, сессии, транспорты, медиа)
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { selectMediaRouteAddress } = require("../mediaNetwork");
const { shouldCloseBridgeSessionAfterEventStreamClose } = require("../bridgeSessionLiveness");
const { getUserById, updateBridgePortAudioLevel, getAllFeeds, getUserTargetAudioStates, updateFeedBridgeEndpoint, updateUserBridgeEndpoint } = require("../dbHandler");
const ns = require("../ns");
const { BRIDGE_REGISTRY_STALE_MS, app, bridgeRegistry, bridgeTokenStore, saveBridgeTokenStore } = ns.base;
const { resolveTransportAnnouncedAddress } = ns.config;
const { scheduleAdminStatusBroadcast } = ns.sessions;
const { canBridgeAuthAccessBridge, generateBridgeToken, hashBridgeToken, requireBridgeApiAuth } = ns.companionAuth;
const { allowBridgeCors, buildBridgeRuntimeConfig, normalizeBridgeId, normalizeBridgeRegistryText, requireBridgeControlSession, sanitizeBridgeInventory, serializeBridgeRegistryEntry } = ns.bridgeRegistry;
const { getPeerActiveTalkProducers, normalizeRuntimeTalkTargets } = ns.talkTargets;
const { broadcastRuntimeUserStates, buildCompanionUserState, emitCompanionEvent, settleCompanionPendingCommand, syncPeerCompanionState, updateCompanionUserState } = ns.companionState;
const { collectBridgeInputPacketStats, normalizeBridgePlatform, recordBridgeNetworkStats } = ns.adminStatus;

app.use("/api/v1/bridge", allowBridgeCors);

app.post("/api/v1/bridge/announce", requireBridgeApiAuth, (req, res) => {
  const body = req.body || {};
  const inventory = sanitizeBridgeInventory(body.inventory || {});
  const id = normalizeBridgeId(body.bridgeId || body.id);
  if (!canBridgeAuthAccessBridge(req.bridgeApiAuth, id)) {
    return res.status(403).json({ error: "Bridge registration requires global API key access or this bridge token" });
  }
  const name = normalizeBridgeRegistryText(body.bridgeName || body.name, id);
  const platform = normalizeBridgePlatform(body.platform);
  const now = Date.now();
  const previousEntry = bridgeRegistry.get(id);
  const previousOnline = previousEntry && now - Number(previousEntry.lastSeenAtMs || 0) <= BRIDGE_REGISTRY_STALE_MS;
  const firstSeenAtMs = previousOnline
    ? Number(previousEntry.firstSeenAtMs || previousEntry.lastSeenAtMs || now)
    : now;
  const remoteAddress = normalizeBridgeRegistryText(ns.bridgeControl.resolveBridgeRequestIp(req), null);
  if (previousEntry?.staleTimer) clearTimeout(previousEntry.staleTimer);
  const storedToken = bridgeTokenStore.get(id)?.token || "";
  const bridgeToken = previousEntry?.token || storedToken || generateBridgeToken();
  const bridgeTokenEntry = {
    token: bridgeToken,
    tokenHash: hashBridgeToken(bridgeToken),
    createdAt: bridgeTokenStore.get(id)?.createdAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  bridgeTokenStore.set(id, bridgeTokenEntry);
  saveBridgeTokenStore();
  const entry = {
    id,
    name,
    platform,
    inventory,
    remoteAddress,
    token: bridgeToken,
    tokenHash: bridgeTokenEntry.tokenHash,
    firstSeenAtMs,
    firstSeenAtIso: new Date(firstSeenAtMs).toISOString(),
    lastSeenAtMs: now,
    lastSeenAtIso: new Date(now).toISOString(),
    staleTimer: null,
  };
  entry.staleTimer = setTimeout(() => {
    scheduleAdminStatusBroadcast("bridge-stale");
  }, BRIDGE_REGISTRY_STALE_MS + 100);
  bridgeRegistry.set(id, entry);
  scheduleAdminStatusBroadcast("bridge-announced");

  res.json({
    bridge: serializeBridgeRegistryEntry(entry, now),
    bridgeToken,
    config: buildBridgeRuntimeConfig(id),
  });
});

app.get("/api/v1/bridge/:bridgeId/config", requireBridgeApiAuth, (req, res) => {
  if (!canBridgeAuthAccessBridge(req.bridgeApiAuth, req.params.bridgeId)) {
    return res.status(403).json({ error: "Bridge config requires global API key access or this bridge token" });
  }
  res.json(buildBridgeRuntimeConfig(req.params.bridgeId));
});

app.put('/api/v1/bridge/:bridgeId/ports/:kind/:id/levels/:direction', requireBridgeApiAuth, (req, res) => {
  const bridgeId = normalizeBridgeId(req.params.bridgeId);
  if (!canBridgeAuthAccessBridge(req.bridgeApiAuth, bridgeId)) return res.status(403).json({ error: 'Bridge access denied' });
  const { kind, direction } = req.params;
  const id = Number(req.params.id);
  const port = buildBridgeRuntimeConfig(bridgeId).ports.find(port => port.kind === kind && Number(port.userId ?? port.feedId) === id);
  if (!port) return res.status(404).json({ error: 'Bridge port not assigned to this bridge' });
  try {
    const audioLevels = updateBridgePortAudioLevel(kind, id, direction, req.body);
    res.json({ ok: true, audioLevels });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/v1/bridge/:bridgeId/ports/:kind/:id", requireBridgeApiAuth, (req, res) => {
  const bridgeId = normalizeBridgeId(req.params.bridgeId);
  if (!canBridgeAuthAccessBridge(req.bridgeApiAuth, bridgeId)) {
    return res.status(403).json({ error: "Bridge port updates require access to this bridge" });
  }

  const kind = String(req.params.kind || "").trim().toLowerCase();
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId < 1) {
    return res.status(400).json({ error: "Invalid bridge port id" });
  }

  const config = {
    ...(req.body || {}),
    enabled: true,
    bridgeDevice: bridgeId,
  };

  try {
    if (kind === "user") {
      const user = getUserById(targetId);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.is_guest_profile) {
        return res.status(403).json({ error: "Guest profile cannot be a bridge endpoint" });
      }
      if (user.is_superadmin) {
        return res.status(403).json({ error: "Superadmin cannot be a bridge endpoint" });
      }
      const updated = updateUserBridgeEndpoint(targetId, config);
      if (!updated) return res.status(404).json({ error: "User not found" });
      scheduleAdminStatusBroadcast("bridge-endpoint-updated");
      return res.json(buildBridgeRuntimeConfig(bridgeId));
    }

    if (kind === "feed") {
      const feed = getAllFeeds().find((entry) => Number(entry.id) === targetId);
      if (!feed) return res.status(404).json({ error: "Feed not found" });
      const updated = updateFeedBridgeEndpoint(targetId, config);
      if (!updated) return res.status(404).json({ error: "Feed not found" });
      scheduleAdminStatusBroadcast("bridge-feed-endpoint-updated");
      return res.json(buildBridgeRuntimeConfig(bridgeId));
    }

    return res.status(400).json({ error: "Bridge port kind must be user or feed" });
  } catch (err) {
    const message = String(err?.message || "Invalid bridge endpoint config");
    if (
      message.includes("channel") ||
      message.includes("required") ||
      message.toLowerCase().includes("production") ||
      message.toLowerCase().includes("trigger") ||
      message.includes("Invalid user id") ||
      message.includes("Invalid feed id")
    ) {
      return res.status(400).json({ error: message });
    }
    console.error("Error updating bridge port endpoint:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/v1/bridge/sessions", requireBridgeApiAuth, (req, res) => {
  if (!canBridgeAuthAccessBridge(req.bridgeApiAuth, req.body?.bridgeId)) {
    return res.status(403).json({ error: "Bridge sessions require global API key access or this bridge token" });
  }
  try {
    const session = ns.bridgeControl.createBridgeControlSession({
      bridgeId: req.body?.bridgeId,
      userId: req.body?.userId,
      feedId: req.body?.feedId,
      portId: req.body?.portId,
      remoteAddress: ns.bridgeControl.resolveBridgeRequestIp(req),
    });
    res.json({
      sessionId: session.id,
      port: session.port,
      panelSettings: session.peer?.kind === 'user' ? ns.producerRouting.remotePanels.savedSettings(session.peer.userId) : null,
      targetAudioStates: session.peer?.kind === 'user' ? getUserTargetAudioStates(session.peer.userId) : [],
    });
  } catch (error) {
    res.status(400).json({ error: error?.message || "Failed to create bridge session" });
  }
});

app.delete(
  "/api/v1/bridge/sessions/:sessionId",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  (req, res) => {
    const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 300)
      : "bridge-session-client-stop";
    ns.bridgeControl.closeBridgeControlSession(req.bridgeSession.id, reason);
    res.json({ ok: true });
  }
);

app.post(
  "/api/v1/bridge/sessions/:sessionId/heartbeat",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  async (req, res) => {
    ns.bridgeControl.logBridgeMediaDiagnostics(req.bridgeSession, req.body?.mediaDiagnostics);
    let packetStats = null;
    try {
      packetStats = await collectBridgeInputPacketStats(req.bridgePeer);
    } catch (error) {
      console.warn(`[MEDIA][BRIDGE][STATS] Failed to collect input RTP stats: ${error?.message || error}`);
    }
    if (!req.bridgeSession.closed) {
      recordBridgeNetworkStats(req.bridgeSession, req.body?.networkStats, packetStats);
      scheduleAdminStatusBroadcast("bridge-network-stats");
    }
    for (const entry of Array.isArray(req.body?.lifecycleEvents) ? req.body.lifecycleEvents.slice(-20) : []) {
      const event = typeof entry?.event === "string" ? entry.event.trim().slice(0, 80) : "unknown";
      const detail = typeof entry?.detail === "string" ? entry.detail.trim().slice(0, 500) : "";
      if (!event) continue;
      console.log(
        `[MEDIA][BRIDGE][LIFECYCLE] ${req.bridgeSession.bridgeId}/${req.bridgeSession.kind}:`
        + `${req.bridgeSession.userId ?? req.bridgeSession.feedId} event=${JSON.stringify(event)}`
        + (detail ? ` detail=${JSON.stringify(detail)}` : "")
      );
    }
    res.json({ ok: true });
  }
);

app.get(
  "/api/v1/bridge/sessions/:sessionId/events",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  (req, res) => {
    const events = req.bridgeSession.events.splice(0, 100);
    res.json({ events });
  }
);

app.get(
  "/api/v1/bridge/sessions/:sessionId/events/stream",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  (req, res) => {
    const session = req.bridgeSession;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    req.socket?.setTimeout?.(0);

    const stream = {
      res,
      heartbeat: null,
    };
    session.eventStreams.add(stream);
    res.write("retry: 1000\n\n");

    const queuedEvents = session.events.splice(0, 100);
    for (const event of queuedEvents) {
      ns.bridgeControl.writeSseEvent(res, "bridge-event", event);
    }

    stream.heartbeat = setInterval(() => {
      if (session.closed) {
        clearInterval(stream.heartbeat);
        session.eventStreams.delete(stream);
        try {
          res.end();
        } catch {}
        return;
      }
      try {
        res.write(": heartbeat\n\n");
        // The Bridge keeps this SSE stream in its native process. Its webview
        // heartbeat may be throttled while the app is hidden, but a writable
        // native stream still proves that this control session is alive.
        session.lastSeenAt = Date.now();
      } catch {
        session.eventStreams.delete(stream);
        clearInterval(stream.heartbeat);
      }
    }, 25_000);

    res.on("close", () => {
      session.eventStreams.delete(stream);
      clearInterval(stream.heartbeat);
      if (shouldCloseBridgeSessionAfterEventStreamClose(session)) {
        ns.bridgeControl.closeBridgeControlSession(session.id, "bridge-event-stream-disconnected");
      }
    });
  }
);

app.get(
  "/api/v1/bridge/sessions/:sessionId/active-producers",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  (req, res) => {
    res.json({
      producers: ns.bridgeControl.listActiveProducersForPeer(req.bridgePeer, req.bridgeSession.id),
    });
  }
);

app.post(
  "/api/v1/bridge/sessions/:sessionId/plain-send-transport",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  async (req, res) => {
    try {
      if (!ns.bridgeControl.router) return res.status(503).json({ error: "Router not initialized" });
      const peer = req.bridgePeer;
      const mediaRoute = resolveTransportAnnouncedAddress();
      if (mediaRoute.error || !mediaRoute.announcedAddress) {
        return res.status(500).json({ error: mediaRoute.error || "No announced media IP" });
      }
      const mediaAddress = selectMediaRouteAddress(mediaRoute, req.socket?.localAddress);
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
        if (peer.plainSendTransport === transport) peer.plainSendTransport = null;
      });
      res.json({
        id: transport.id,
        ip: mediaAddress,
        port: transport.tuple.localPort,
        protocol: transport.tuple.protocol,
        payloadType: ns.bridgeControl.GATEWAY_OPUS_PAYLOAD_TYPE,
        ssrc: ns.bridgeControl.GATEWAY_OPUS_SSRC
          + (req.bridgePeer.kind === "feed"
            ? 10000 + Number(req.bridgePeer.feedId || 0)
            : Number(req.bridgePeer.userId || 0)),
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || "Failed to create plain send transport" });
    }
  }
);

app.post(
  "/api/v1/bridge/sessions/:sessionId/producers",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  async (req, res) => {
    try {
      const peer = req.bridgePeer;
      const transport = peer.plainSendTransport;
      if (!transport || transport.closed) {
        return res.status(409).json({ error: "Plain send transport not ready" });
      }
      const producerAppData = peer.kind === "feed"
        ? { type: "feed", id: Number(peer.feedId) }
        : { type: "talk" };
      const producerCname = peer.kind === "feed"
        ? `linktalk-bridge-feed-${peer.feedId}`
        : `linktalk-bridge-${peer.userId}`;
      for (const [existingId, existing] of peer.producers.entries()) {
        const existingType = String(existing?.appData?.type || "");
        const isSameProducerKind = peer.kind === "feed"
          ? existingType === "feed" && String(existing?.appData?.id) === String(peer.feedId)
          : existingType === "talk";
        if (isSameProducerKind) {
          try {
            existing.close();
          } catch {}
          peer.producers.delete(existingId);
        }
      }
      const payloadType = Number(req.body?.payloadType || ns.bridgeControl.GATEWAY_OPUS_PAYLOAD_TYPE);
      const fallbackSsrc = ns.bridgeControl.GATEWAY_OPUS_SSRC + (
        peer.kind === "feed" ? 10000 + Number(peer.feedId || 0) : Number(peer.userId || 0)
      );
      const ssrc = Number(req.body?.ssrc || fallbackSsrc);
      const producer = await transport.produce({
        kind: "audio",
        rtpParameters: ns.bridgeControl.buildGatewayAudioRtpParameters({
          payloadType,
          ssrc,
          cname: producerCname,
          stereo: true,
        }),
        appData: producerAppData,
      });
      ns.bridgeControl.attachProducerMediaDiagnostics(
        producer,
        `bridge:${req.bridgeSession.bridgeId}/${req.bridgeSession.kind}:${req.bridgeSession.userId ?? req.bridgeSession.feedId}`
      );
      producer.__startedAt = Date.now();
      peer.producers.set(producer.id, producer);
      producer.__recipientDeliveries = new Map();
      producer.observer.on("pause", () => {
        syncPeerCompanionState(peer, { reason: "bridge-producer-paused" });
        broadcastRuntimeUserStates("bridge-producer-paused");
      });
      producer.observer.on("resume", () => {
        producer.__startedAt = Date.now();
        ns.producerRouting.announceProducerToRecipients({
          producerId: producer.id,
          appData: producer.appData,
          speakerSocketId: req.bridgeSession.id,
          forceAnnounce: true,
        });
        syncPeerCompanionState(peer, { reason: "bridge-producer-resumed" });
        broadcastRuntimeUserStates("bridge-producer-resumed");
      });
      producer.on("transportclose", () => {
        peer.producers.delete(producer.id);
      });
      if (peer.kind === "feed") {
        ns.producerRouting.announceProducerToRecipients({
          producerId: producer.id,
          appData: producer.appData,
          speakerSocketId: req.bridgeSession.id,
        });
        syncPeerCompanionState(peer, { reason: "bridge-feed-producer-started" });
        broadcastRuntimeUserStates("bridge-feed-producer-started");
      } else {
        await producer.pause();
      }
      res.json({ id: producer.id });
    } catch (error) {
      res.status(500).json({ error: error?.message || "Failed to create bridge producer" });
    }
  }
);

app.post(
  "/api/v1/bridge/sessions/:sessionId/producers/:producerId/:action",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  async (req, res) => {
    const producer = req.bridgePeer.producers.get(req.params.producerId);
    if (!producer) return res.status(404).json({ error: "Producer not found" });
    try {
      if (req.params.action === "pause") {
        await producer.pause();
      } else if (req.params.action === "resume") {
        await producer.resume();
      } else {
        return res.status(400).json({ error: "Action must be pause or resume" });
      }
      res.json({ ok: true, paused: producer.paused });
    } catch (error) {
      res.status(500).json({ error: error?.message || "Failed to change producer state" });
    }
  }
);

app.post(
  "/api/v1/bridge/sessions/:sessionId/talk-state",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  (req, res) => {
    const peer = req.bridgePeer;
    if (peer.kind !== "user") {
      return res.status(400).json({ error: "Talk state is only supported for user bridge sessions" });
    }
    const targets = normalizeRuntimeTalkTargets(req.body?.targets);
    const talking = Boolean(req.body?.talking && targets.length > 0);
    peer.activeTalkTargets = talking ? targets : [];
    peer.pttTalking = talking;
    peer.pttStartedAt = talking ? (peer.pttStartedAt || Date.now()) : 0;
    updateCompanionUserState(peer.userId, {
      userName: peer.name,
      online: true,
      socketId: req.bridgeSession.id,
      talking,
      talkLocked: Boolean(req.body?.lockActive),
      currentTarget: talking ? targets[0] : null,
      currentTargets: talking ? targets : [],
      lastTarget: targets[0] || undefined,
      lastTargets: targets.length ? targets : undefined,
    }, {
      reason: "bridge-talk-state",
      fallbackName: peer.name,
    });
    if (talking) {
      for (const producer of getPeerActiveTalkProducers(peer)) {
        ns.producerRouting.syncProducerRecipients({ producer, speakerSocketId: req.bridgeSession.id });
      }
    }
    syncPeerCompanionState(peer, { reason: "bridge-talk-state" });
    broadcastRuntimeUserStates("bridge-talk-state");
    res.json({ ok: true, talking, targets });
  }
);

app.post(
  "/api/v1/bridge/sessions/:sessionId/command-result",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  (req, res) => {
    if (req.bridgePeer.kind !== "user") {
      return res.status(400).json({ error: "Command results are only supported for user bridge sessions" });
    }
    const payload = req.body || {};
    const commandId = typeof payload.commandId === "string" ? payload.commandId : null;
    if (payload.report) ns.producerRouting.remotePanels.report(req.bridgePeer, payload.report);
    if (commandId) {
      const result = {
        commandId,
        userId: req.bridgePeer.userId,
        userName: req.bridgePeer.name,
        socketId: req.bridgeSession.id,
        ok: Boolean(payload.ok),
        action: payload.action || null,
        targetType: payload.targetType || null,
        targetId: payload.targetId ?? null,
        reason: payload.reason || null,
        error: payload.ok ? null : payload.reason || 'Bridge could not apply the change',
        message: typeof payload.message === 'string' ? payload.message : null,
        at: new Date().toISOString(),
      };
      updateCompanionUserState(req.bridgePeer.userId, {
        lastCommandId: commandId,
        lastCommandResult: result.ok ? "ok" : (result.reason || "failed"),
      }, {
        reason: "bridge-command-result",
        fallbackName: req.bridgePeer.name,
      });
      result.state = buildCompanionUserState(req.bridgePeer.userId, req.bridgePeer.name);
      settleCompanionPendingCommand(commandId, result);
      emitCompanionEvent("command-result", result);
    }
    res.json({ ok: true });
  }
);

app.post(
  "/api/v1/bridge/sessions/:sessionId/consumers",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  async (req, res) => {
    try {
      if (req.bridgePeer.kind !== "user") {
        return res.status(400).json({ error: "Bridge consumers are only supported for user bridge sessions" });
      }
      if (!ns.bridgeControl.router) return res.status(503).json({ error: "Router not initialized" });
      const producerId = String(req.body?.producerId || "");
      // New Bridge clients establish the return path from their reserved UDP
      // receive port. Keep the explicit target fallback for older clients.
      const useRtpHandshake = req.body?.rtpHandshake === true;
      const targetPort = Number(req.body?.port);
      const targetIp = useRtpHandshake ? "" : ns.bridgeControl.resolveBridgeRequestIp(req);
      if (
        !producerId
        || (!useRtpHandshake && (
          !targetIp
          || !Number.isInteger(targetPort)
          || targetPort < 1
          || targetPort > 65535
        ))
      ) {
        return res.status(400).json({ error: "Invalid bridge consumer target" });
      }
      let producerPeerId = null;
      for (const [peerId, peer] of ns.bridgeControl.peers) {
        if (peer.producers.has(producerId)) {
          producerPeerId = peerId;
          break;
        }
      }
      if (!producerPeerId) return res.status(404).json({ error: "Producer not found" });
      if (!ns.bridgeControl.router.canConsume({ producerId, rtpCapabilities: ns.bridgeControl.router.rtpCapabilities })) {
        return res.status(409).json({ error: "Cannot consume producer" });
      }
      const mediaRoute = useRtpHandshake ? resolveTransportAnnouncedAddress() : null;
      if (useRtpHandshake && (mediaRoute?.error || !mediaRoute?.announcedAddress)) {
        return res.status(500).json({ error: mediaRoute?.error || "No announced media IP" });
      }
      const mediaAddress = useRtpHandshake
        ? selectMediaRouteAddress(mediaRoute, req.socket?.localAddress)
        : "";
      const transport = await ns.bridgeControl.router.createPlainTransport({
        listenIp: useRtpHandshake
          ? { ip: "0.0.0.0", announcedIp: mediaAddress }
          : { ip: "0.0.0.0" },
        rtcpMux: true,
        comedia: useRtpHandshake,
      });
      if (!useRtpHandshake) {
        await transport.connect({ ip: targetIp, port: targetPort });
      }
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: ns.bridgeControl.router.rtpCapabilities,
        paused: true,
      });
      consumer.__plainTransport = transport;
      consumer.__bridgeRtpHandshakeRequired = useRtpHandshake;
      req.bridgePeer.consumers.set(consumer.id, consumer);
      if (useRtpHandshake) {
        transport.on("tuple", (tuple) => {
          console.log(
            `[BRIDGE][RTP] Learned return path ${tuple.remoteIp}:${tuple.remotePort} `
            + `for consumer ${consumer.id}`
          );
        });
        console.log(
          `[BRIDGE][RTP] Waiting for return-path handshake on `
          + `${mediaAddress}:${transport.tuple.localPort} for consumer ${consumer.id}`
        );
      }
      const cleanup = () => {
        req.bridgePeer?.consumers.delete(consumer.id);
        try {
          if (!transport.closed) transport.close();
        } catch {}
      };
      consumer.on("transportclose", cleanup);
      consumer.on("producerclose", () => {
        cleanup();
        ns.bridgeControl.queueBridgeControlEvent(req.bridgeSession, "consumer-closed", {
          consumerId: consumer.id,
          producerId,
        });
      });
      res.json({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        transport: useRtpHandshake ? {
          ip: mediaAddress,
          port: transport.tuple.localPort,
          protocol: transport.tuple.protocol,
          rtcpMux: true,
          comedia: true,
        } : null,
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || "Failed to create bridge consumer" });
    }
  }
);

app.post(
  "/api/v1/bridge/sessions/:sessionId/consumers/:consumerId/resume",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  async (req, res) => {
    const consumer = req.bridgePeer.consumers.get(req.params.consumerId);
    if (!consumer) return res.status(404).json({ error: "Consumer not found" });
    try {
      if (consumer.__bridgeRtpHandshakeRequired) {
        await ns.bridgeControl.waitForBridgeRtpHandshake(consumer.__plainTransport);
      }
      await consumer.resume();
      res.json({ ok: true });
    } catch (error) {
      const status = error?.code === "BRIDGE_RTP_HANDSHAKE_TIMEOUT" ? 504 : 500;
      console.warn(`[BRIDGE][RTP] Failed to resume consumer ${consumer.id}:`, error?.message || error);
      res.status(status).json({ error: error?.message || "Failed to resume bridge consumer" });
    }
  }
);

app.delete(
  "/api/v1/bridge/sessions/:sessionId/consumers/:consumerId",
  requireBridgeApiAuth,
  requireBridgeControlSession,
  (req, res) => {
    const consumer = req.bridgePeer.consumers.get(req.params.consumerId);
    if (consumer) {
      const transport = consumer.__plainTransport;
      try {
        consumer.close();
      } catch {}
      req.bridgePeer.consumers.delete(consumer.id);
      try {
        if (transport && !transport.closed) transport.close();
      } catch {}
    }
    res.json({ ok: true });
  }
);