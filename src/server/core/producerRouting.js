/**
 * LinkTalk server — маршрутизация потоков между участниками
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const crypto = require("crypto");
const { producerDeliveryChanged, shouldAnnounceProducerDelivery } = require("../producerReconciliation");
const { getUserById, getUserPanelSettings, updateUserPanelSettings, mergeUserTargetAudioStates, updateUserAudioSettings, getPrimaryProduction, isUserInProduction, getBridgeTargetsForUser, updateProductionTargetOrder, getUserTargetAudioStates } = require("../dbHandler");
const monitoring = require("../monitoring");
const ns = require("../ns");
const { app } = ns.base;
const { getEffectiveFeedIdsForPeer, getEnabledProductionsForUser } = ns.config;
const { getAdminSession, requireAdmin, scheduleAdminStatusBroadcast } = ns.sessions;
const { arePeersInSameActiveProduction, buildIncomingTalkStateForUser, isOperatorPeer, isPeerMemberOfConference, isTalkTargetAllowedForPeer, normalizeRuntimeTalkTargets, resolveRecipientPeersForTarget } = ns.talkTargets;
const { buildOperatorTargetsForUser, findUserPeerByUserId, registerCompanionPendingCommand, updateCompanionUserState } = ns.companionState;
const { getResolvedUserAudioSettings } = ns.routesUsers;
const { notifyTargetChange } = ns.entityNotifications;
const { io } = ns.webServer;
const { peers } = ns.bridgeControl;

function getUserList() {
  return Array.from(peers.entries()).map(([socketId, peer]) => ({
    socketId,
    userId: peer.userId ?? null,
    feedId: peer.feedId ?? null,
    guestId: peer.guestId ?? null,
    guestProfileUserId: peer.guestProfileUserId ?? null,
    kind: peer.kind ?? (peer.userId ? "user" : peer.feedId ? "feed" : "guest"),
    name: peer.name || null
  }));
}

function resolveProducerRecipientDeliveriesForTargets({ targets, speakerSocketId }) {
  const deliveries = [];
  const seenRecipients = new Set();
  const speakerPeer = peers.get(speakerSocketId);

  for (const target of normalizeRuntimeTalkTargets(targets)) {
    if (!isTalkTargetAllowedForPeer(speakerPeer, target)) {
      continue;
    }
    const recipients = resolveRecipientPeersForTarget(target, speakerSocketId);
    for (const { socketId: recipientSocketId } of recipients) {
      if (!recipientSocketId || seenRecipients.has(recipientSocketId)) continue;
      seenRecipients.add(recipientSocketId);
      const appData = target.type === "conference"
        ? { type: "conference", id: Number(target.id) }
        : target.type === "guest"
          ? { type: "guest", id: String(target.id), targetPeer: recipientSocketId }
          : { type: "user", id: Number(target.id), targetPeer: recipientSocketId };
      deliveries.push({ recipientSocketId, appData });
    }
  }

  return deliveries;
}

// LinkTalk: к обычным получателям добавляем тех, кто «подслушивает» говорящего.
function resolveProducerRecipientDeliveries({ appData, speakerSocketId }) {
  const base = resolveProducerRecipientDeliveriesBase({ appData, speakerSocketId });
  const type = typeof appData?.type === "string" ? appData.type.trim().toLowerCase() : "";
  if (type === "feed" || ns.monitorCache.monitorLinks.length === 0) return base;
  const extra = monitoring.buildMonitorDeliveries({
    speakerSocketId,
    peers,
    links: ns.monitorCache.monitorLinks,
    alreadyDelivered: base.map((delivery) => delivery.recipientSocketId),
    isEligible: (speakerPeer, recipientPeer) =>
      isOperatorPeer(recipientPeer) && arePeersInSameActiveProduction(speakerPeer, recipientPeer),
  });
  return extra.length > 0 ? [...base, ...extra] : base;
}

function resolveProducerRecipientDeliveriesBase({ appData, speakerSocketId }) {
  const type = typeof appData?.type === "string" ? appData.type.trim().toLowerCase() : "";
  const targetId = appData?.id;

  if (type === "talk") {
    const speakerPeer = peers.get(speakerSocketId);
    return resolveProducerRecipientDeliveriesForTargets({
      targets: speakerPeer?.activeTalkTargets || [],
      speakerSocketId,
    });
  }

  if (type === "user" || type === "conference" || type === "guest") {
    return resolveProducerRecipientDeliveriesForTargets({
      targets: [{ type, id: targetId }],
      speakerSocketId,
    });
  }

  if (type === "feed") {
    const deliveries = [];
    const speakerPeer = peers.get(speakerSocketId);
    for (const [sid, peer] of peers) {
      if (sid === speakerSocketId) continue;
      if (!isOperatorPeer(peer)) continue;
      if (!arePeersInSameActiveProduction(speakerPeer, peer)) continue;
      const feedIds = new Set(getEffectiveFeedIdsForPeer(peer).map((id) => String(id)));
      if (feedIds.has(String(targetId))) {
        deliveries.push({
          recipientSocketId: sid,
          appData: { ...appData },
        });
      }
    }
    return deliveries;
  }

  return [];
}

function closeProducerConsumersForRecipient({ producerId, recipientSocketId }) {
  const recipientPeer = peers.get(recipientSocketId);
  if (!recipientPeer) return;

  for (const consumer of Array.from(recipientPeer.consumers.values())) {
    if (String(consumer?.producerId || "") !== String(producerId)) {
      continue;
    }
    try {
      consumer.close();
      recipientPeer.consumers.delete(consumer.id);
      recipientPeer.socket?.emit("consumer-closed", { consumerId: consumer.id });
    } catch (error) {
      console.warn(`[ROUTE] Failed to close consumer ${consumer?.id} for producer ${producerId}:`, error?.message || error);
    }
  }
}

function getProducerRoutingTargets(producer, speakerPeer) {
  const type = String(producer?.appData?.type || "").trim().toLowerCase();
  if (type === "talk") {
    return normalizeRuntimeTalkTargets(speakerPeer?.activeTalkTargets || []);
  }
  if (["user", "conference", "guest"].includes(type)) {
    return normalizeRuntimeTalkTargets([{ type, id: producer?.appData?.id }]);
  }
  return [];
}

function buildConferenceRoutingDiagnostics(targets, speakerSocketId) {
  return targets
    .filter((target) => target?.type === "conference")
    .map((target) => ({
      conferenceId: Number(target.id),
      activePeers: Array.from(peers.entries())
        .filter(([socketId, peer]) => socketId !== speakerSocketId && isOperatorPeer(peer))
        .map(([socketId, peer]) => ({
          socketId,
          kind: peer.kind || null,
          userId: peer.userId ?? null,
          guestProfileUserId: peer.guestProfileUserId ?? null,
          productionId: peer.productionId ?? null,
          recognizedMember: isPeerMemberOfConference(peer, target.id),
        })),
    }));
}

function warnIfActiveProducerHasNoRecipients({ producer, speakerSocketId, speakerPeer, deliveries }) {
  if (!producer || producer.paused || deliveries.length > 0) return;
  const targets = getProducerRoutingTargets(producer, speakerPeer);
  if (targets.length === 0) return;

  console.warn(`[ROUTE][WARN] Active producer ${producer.id} has no recipients ${JSON.stringify({
    speaker: {
      socketId: speakerSocketId,
      kind: speakerPeer?.kind || null,
      userId: speakerPeer?.userId ?? null,
      guestProfileUserId: speakerPeer?.guestProfileUserId ?? null,
      productionId: speakerPeer?.productionId ?? null,
    },
    targets,
    conferences: buildConferenceRoutingDiagnostics(targets, speakerSocketId),
  })}`);
}

function syncProducerRecipients({ producer, speakerSocketId, forceAnnounce = false }) {
  if (!producer) return [];

  const speakerPeer = peers.get(speakerSocketId);

  const deliveries = resolveProducerRecipientDeliveries({
    appData: producer.appData,
    speakerSocketId,
  });
  warnIfActiveProducerHasNoRecipients({
    producer,
    speakerSocketId,
    speakerPeer,
    deliveries,
  });
  const previousDeliveries = producer.__recipientDeliveries instanceof Map
    ? producer.__recipientDeliveries
    : new Map();
  const nextDeliveries = new Map(
    deliveries.map((delivery) => [delivery.recipientSocketId, delivery.appData])
  );

  for (const [recipientSocketId, previousAppData] of previousDeliveries.entries()) {
    const nextAppData = nextDeliveries.get(recipientSocketId);
    const deliveryChanged = producerDeliveryChanged(previousAppData, nextAppData);
    if (!deliveryChanged) continue;
    closeProducerConsumersForRecipient({ producerId: producer.id, recipientSocketId });
  }

  for (const [recipientSocketId, nextAppData] of nextDeliveries.entries()) {
    const previousAppData = previousDeliveries.get(recipientSocketId);
    if (!shouldAnnounceProducerDelivery({
      previousAppData,
      nextAppData,
      forceAnnounce,
    })) continue;
    const recipientPeer = peers.get(recipientSocketId);
    if (!recipientPeer?.socket) continue;
    recipientPeer.socket.emit("new-producer", {
      peerId: speakerSocketId,
      speakerUserId: speakerPeer?.userId ?? null,
      producerId: producer.id,
      appData: nextAppData,
    });
  }

  producer.__recipientDeliveries = nextDeliveries;
  return deliveries;
}

function reconcileAllProducerRecipients({ forceAnnounce = false } = {}) {
  for (const [speakerSocketId, speakerPeer] of peers) {
    for (const producer of speakerPeer?.producers?.values?.() || []) {
      if (!producer || producer.closed) continue;
      syncProducerRecipients({ producer, speakerSocketId, forceAnnounce });
    }
  }
}

function announceProducerToRecipients({
  producerId,
  appData,
  speakerSocketId,
  forceAnnounce = false,
}) {
  const speakerPeer = peers.get(speakerSocketId);
  const producer = speakerPeer?.producers?.get(producerId) || null;
  if (!producer) return [];
  return syncProducerRecipients({
    producer,
    speakerSocketId,
    forceAnnounce,
  }).map((delivery) => delivery.recipientSocketId);
}

function emitUserListToOperators() {
  const userList = getUserList();
  for (const peer of peers.values()) {
    if (!isOperatorPeer(peer)) continue;
    try {
      peer.socket.emit("user-list", userList);
    } catch (err) {
      console.warn("[SIGNAL] Failed to emit user-list to operator:", err?.message || err);
    }
  }
  scheduleAdminStatusBroadcast("peer-list-changed");
}

const remotePanels = require("../remotePanelControl").installRemotePanelControl({
  app, io, publicDir: ns.config.publicDir, requireAdmin, getAdminSession, getUserById, findUserPeerByUserId,
  getUserList, getEnabledProductionsForUser, getPrimaryProduction, isUserInProduction, buildOperatorTargetsForUser,
  getBridgeTargetsForUser, buildIncomingTalkStateForUser, getUserTargetAudioStates,
  getActiveFeedIds() {
    const ids = new Set();
    for (const peer of peers.values()) {
      for (const producer of peer.producers.values()) {
        if (!producer.closed && !producer.paused && producer.appData?.type === 'feed') {
          ids.add(Number(producer.appData.id));
        }
      }
    }
    return [...ids];
  },
  mergeUserTargetAudioStates, getUserPanelSettings, updateUserPanelSettings,
  getResolvedUserAudioSettings, updateUserAudioSettings, updateProductionTargetOrder, notifyTargetChange,
  targetAudioChanged(userId) {
    updateCompanionUserState(userId, { targetAudioStates: getUserTargetAudioStates(userId) }, { reason: 'remote-panel-audio' });
  },
  async sendBridgeCommand(peer, command) {
    const commandId = crypto.randomUUID();
    const { promise } = registerCompanionPendingCommand({ commandId, userId: peer.userId });
    peer.socket.emit('panel-command', { ...command, commandId });
    const result = await Promise.race([promise, new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'Bridge did not confirm the change' }), 5000))]);
    return result;
  },
});
Object.assign(ns.producerRouting, {
  announceProducerToRecipients,
  emitUserListToOperators,
  reconcileAllProducerRecipients,
  remotePanels,
  resolveProducerRecipientDeliveries,
  syncProducerRecipients,
});
