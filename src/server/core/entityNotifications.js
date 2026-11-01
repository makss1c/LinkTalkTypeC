/**
 * LinkTalk server — уведомления клиентов об изменениях целей и продакшенов
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { getProductionsForUser } = require("../dbHandler");
const ns = require("../ns");
const { getEffectiveConferencesForPeer, getEnabledProductionsForUser } = ns.config;
const { scheduleAdminStatusBroadcast } = ns.sessions;
const { isOperatorPeer } = ns.talkTargets;
const { emitCompanionEvent, isCompanionAddressableUserId } = ns.companionState;
const { emitPeerTallyState } = ns.listenConfig;

function notifyTargetChange(userId) {
  const idStr = String(userId);
  for (const [, peer] of ns.bridgeControl.peers) {
    if (
      (peer.kind === "user" && String(peer.userId) === idStr) ||
      (peer.kind === "guest" && String(peer.guestProfileUserId) === idStr)
    ) {
      peer.socket.emit('user-targets-updated');
    }
  }
  if (isCompanionAddressableUserId(userId)) {
    emitCompanionEvent("user-targets-updated", {
      at: new Date().toISOString(),
      userId: Number(userId),
    });
  }
  ns.producerRouting.reconcileAllProducerRecipients();
}

function notifyConferenceMembersChanged(conferenceId, excludedProfileUserId = null) {
  const numericConferenceId = conferenceId == null ? null : Number(conferenceId);
  const excludedId = excludedProfileUserId == null ? null : String(excludedProfileUserId);
  for (const peer of ns.bridgeControl.peers.values()) {
    if (!isOperatorPeer(peer)) continue;
    const profileUserId = peer.kind === "guest" ? peer.guestProfileUserId : peer.userId;
    if (excludedId !== null && String(profileUserId) === excludedId) continue;
    peer.socket.emit('conference-members-updated', {
      conferenceId: numericConferenceId !== null && Number.isFinite(numericConferenceId)
        ? numericConferenceId
        : null,
    });
  }
  ns.producerRouting.reconcileAllProducerRecipients();
}

function resetPeersUsingProduction(productionId, userId = null) {
  const productionKey = String(productionId);
  const userKey = userId == null ? null : String(userId);
  for (const peer of ns.bridgeControl.peers.values()) {
    if (!isOperatorPeer(peer) || String(peer.productionId ?? "") !== productionKey) continue;
    const profileUserId = peer.kind === "guest" ? peer.guestProfileUserId : peer.userId;
    if (userKey !== null && String(profileUserId) !== userKey) continue;
    const fallbackProduction = getProductionsForUser(profileUserId)[0] || null;
    peer.productionId = fallbackProduction?.id ?? null;
    peer.socket.emit("active-production-reset", {
      productionId: peer.productionId,
      reason: "production-access-removed",
    });
    peer.socket.emit("user-targets-updated");
    peer.socket.emit("conference-list", getEffectiveConferencesForPeer(peer));
    peer.socket.emit("conference-members-updated", { conferenceId: null });
    emitPeerTallyState(peer);
  }
  ns.producerRouting.reconcileAllProducerRecipients();
}

function notifyAvailableProductionsChanged(userId = null) {
  const userKey = userId == null ? null : String(userId);
  for (const peer of ns.bridgeControl.peers.values()) {
    if (!isOperatorPeer(peer)) continue;
    const profileUserId = peer.kind === "guest" ? peer.guestProfileUserId : peer.userId;
    if (userKey !== null && String(profileUserId) !== userKey) continue;
    peer.socket.emit("available-productions-updated", {
      productions: getEnabledProductionsForUser(profileUserId).map(({ id, name }) => ({ id, name })),
    });
  }
  // Admin status also needs new mode, production names and offline memberships.
  scheduleAdminStatusBroadcast("productions-updated");
}
Object.assign(ns.entityNotifications, {
  notifyAvailableProductionsChanged,
  notifyConferenceMembersChanged,
  notifyTargetChange,
  resetPeersUsingProduction,
});
