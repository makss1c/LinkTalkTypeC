/**
 * LinkTalk server — цели разговора, получатели и входящая речь
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { arePeersInSameActiveProduction: arePeersInSameActiveProductionScope, canRouteTargetBetweenPeers } = require("../productionRouting");
const { getUserById, getProductionTargets } = require("../dbHandler");
const ns = require("../ns");
const { areMultipleProductionsEnabled, getEffectiveConferencesForPeer } = ns.config;
const { COMPANION_DEFAULT_WAIT_MS, COMPANION_MAX_WAIT_MS } = ns.companionAuth;

function normalizeCompanionTarget(target) {
  if (!target || typeof target !== "object") return null;
  const rawType = typeof target.type === "string" ? target.type.trim().toLowerCase() : "";
  if (!["user", "conference"].includes(rawType)) {
    return null;
  }
  const rawId = target.id;
  if (rawId === null || rawId === undefined || rawId === "") {
    return null;
  }
  const numeric = Number(rawId);
  const normalizedId = Number.isFinite(numeric) ? numeric : String(rawId);
  return { type: rawType, id: normalizedId };
}

function normalizeCompanionTargetAudioState(state) {
  if (!state || typeof state !== "object") return null;
  const rawType = typeof state.targetType === "string" ? state.targetType.trim().toLowerCase() : "";
  if (!["user", "conference", "feed"].includes(rawType)) {
    return null;
  }

  const targetId = Number(state.targetId);
  if (!Number.isFinite(targetId)) {
    return null;
  }

  const rawVolume = Number(state.volume);
  const volume = Number.isFinite(rawVolume)
    ? Math.min(1, Math.max(0, rawVolume))
    : null;

  return {
    targetType: rawType,
    targetId,
    muted: Boolean(state.muted),
    volume,
  };
}

function normalizeCompanionTargetAudioStates(states) {
  if (!Array.isArray(states)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const rawState of states) {
    const state = normalizeCompanionTargetAudioState(rawState);
    if (!state) continue;
    const key = `${state.targetType}:${state.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(state);
  }

  return normalized;
}

function resolveUserIdFromTargetIdentity(rawId) {
  if (rawId === null || rawId === undefined || rawId === "") {
    return null;
  }

  const socketId = typeof rawId === "string" ? rawId.trim() : "";
  if (socketId) {
    const peer = ns.bridgeControl.peers.get(socketId);
    if (peer?.kind === "user" && peer.userId !== null && peer.userId !== undefined) {
      const peerUserId = Number(peer.userId);
      if (Number.isFinite(peerUserId)) {
        return peerUserId;
      }
    }
  }

  const numericId = Number(rawId);
  if (Number.isFinite(numericId)) {
    const user = getUserById(numericId);
    if (ns.companionState.isCompanionAddressableUser(user)) {
      return Number(user.id);
    }
  }

  const found = ns.companionState.findUserPeerByUserId(rawId);
  if (found?.peer?.userId !== null && found?.peer?.userId !== undefined) {
    const peerUserId = Number(found.peer.userId);
    if (Number.isFinite(peerUserId)) {
      return peerUserId;
    }
  }

  return null;
}

function isOperatorPeer(peer) {
  return Boolean(peer && (peer.kind === "user" || peer.kind === "guest"));
}

function isPersistentUserPeer(peer) {
  return Boolean(peer && peer.kind === "user" && peer.userId !== null && peer.userId !== undefined);
}

function findGuestPeerByGuestId(guestId) {
  const key = String(guestId ?? "");
  if (!key) return null;
  for (const [socketId, peer] of ns.bridgeControl.peers) {
    if (peer?.kind === "guest" && String(peer.guestId || "") === key) {
      return { socketId, peer };
    }
  }
  return null;
}

function normalizeRuntimeTalkTarget(target) {
  if (!target || typeof target !== "object") return null;
  const rawType = typeof target.type === "string" ? target.type.trim().toLowerCase() : "";

  if (rawType === "guest") {
    const guestId = String(target.id ?? "").trim();
    if (!guestId) {
      return null;
    }
    return { type: "guest", id: guestId };
  }

  const normalized = normalizeCompanionTarget(target);
  if (!normalized) return null;

  if (normalized.type === "conference") {
    const conferenceId = Number(normalized.id);
    if (!Number.isFinite(conferenceId)) {
      return null;
    }
    return { type: "conference", id: conferenceId };
  }
  const userId = resolveUserIdFromTargetIdentity(normalized.id);
  if (!Number.isFinite(userId)) {
    return null;
  }

  return { type: "user", id: Number(userId) };
}

function normalizeRuntimeTalkTargets(targets) {
  if (!Array.isArray(targets)) {
    return [];
  }

  const normalizedTargets = [];
  const seen = new Set();
  for (const rawTarget of targets) {
    const target = normalizeRuntimeTalkTarget(rawTarget);
    if (!target) continue;
    const key = `${target.type}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedTargets.push(target);
  }

  return normalizedTargets;
}

function normalizeCompanionVisibleRuntimeTalkTarget(target) {
  const normalized = normalizeRuntimeTalkTarget(target);
  if (!normalized || normalized.type === "guest") {
    return null;
  }
  return normalized;
}

function normalizeCompanionVisibleRuntimeTalkTargets(targets) {
  if (!Array.isArray(targets)) {
    return [];
  }
  const normalizedTargets = [];
  const seen = new Set();
  for (const rawTarget of targets) {
    const target = normalizeCompanionVisibleRuntimeTalkTarget(rawTarget);
    if (!target) continue;
    const key = `${target.type}:${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedTargets.push(target);
  }
  return normalizedTargets;
}

function isLiveTalkProducerAppData(appData) {
  const type = typeof appData?.type === "string" ? appData.type.trim().toLowerCase() : "";
  return type === "talk" || type === "user" || type === "conference" || type === "guest";
}

function getPeerTalkProducers(peer, { includePaused = false } = {}) {
  if (!isOperatorPeer(peer)) {
    return [];
  }

  return Array.from(peer.producers.values()).filter((producer) => (
    producer
    && (includePaused || !producer.paused)
    && isLiveTalkProducerAppData(producer.appData)
  ));
}

function getPeerActiveTalkProducers(peer) {
  return getPeerTalkProducers(peer);
}

function getPeerActiveTalkTargets(peer) {
  if (peer?.pttTalking) {
    return normalizeRuntimeTalkTargets(peer.activeTalkTargets)
      .filter((target) => isTalkTargetAllowedForPeer(peer, target));
  }

  const activeProducers = getPeerActiveTalkProducers(peer);
  if (activeProducers.length === 0) {
    return [];
  }

  const hasGenericTalkProducer = activeProducers.some((producer) => (
    String(producer?.appData?.type || "").trim().toLowerCase() === "talk"
  ));

  if (hasGenericTalkProducer) {
    return normalizeRuntimeTalkTargets(peer.activeTalkTargets)
      .filter((target) => isTalkTargetAllowedForPeer(peer, target));
  }

  return normalizeRuntimeTalkTargets(
    activeProducers.map((producer) => ({
      type: producer?.appData?.type,
      id: producer?.appData?.id,
    }))
  ).filter((target) => isTalkTargetAllowedForPeer(peer, target));
}

function getPeerActiveTalkInfo(peer) {
  if (!isOperatorPeer(peer)) {
    return null;
  }

  if (peer.pttTalking) {
    const targets = getPeerActiveTalkTargets(peer);
    if (targets.length === 0) {
      return null;
    }
    return {
      target: targets[0],
      targets,
      at: Number(peer.pttStartedAt) || Date.now(),
    };
  }

  const activeProducers = getPeerActiveTalkProducers(peer);
  if (activeProducers.length === 0) {
    return null;
  }

  let latestAt = 0;
  for (const producer of activeProducers) {
    const startedAt = Number(producer.__startedAt);
    const at = Number.isFinite(startedAt) ? startedAt : Date.now();
    if (at >= latestAt) latestAt = at;
  }

  const targets = getPeerActiveTalkTargets(peer);
  if (targets.length === 0) {
    return null;
  }

  return {
    target: targets[0] || null,
    targets,
    at: latestAt || Date.now(),
  };
}

function getRecipientKeyForPeer(peer) {
  if (isPersistentUserPeer(peer)) {
    return `user:${Number(peer.userId)}`;
  }
  if (peer?.kind === "guest" && peer.guestId) {
    return `guest:${String(peer.guestId)}`;
  }
  return null;
}

function getRecipientKeyForUserId(userId) {
  const numericUserId = Number(userId);
  return Number.isFinite(numericUserId) ? `user:${numericUserId}` : null;
}

function isPeerMemberOfConference(peer, conferenceId) {
  const numericConferenceId = Number(conferenceId);
  if (!Number.isFinite(numericConferenceId) || !isOperatorPeer(peer)) {
    return false;
  }
  return getEffectiveConferencesForPeer(peer)
    .some((conference) => Number(conference?.id) === numericConferenceId);
}

function arePeersInSameActiveProduction(firstPeer, secondPeer) {
  return arePeersInSameActiveProductionScope(
    firstPeer,
    secondPeer,
    areMultipleProductionsEnabled()
  );
}

function isTalkTargetAllowedForPeer(peer, target) {
  if (!target || !isOperatorPeer(peer)) return false;
  if (target.type !== "conference") return true;
  if (!isPeerMemberOfConference(peer, target.id)) return false;
  if (!areMultipleProductionsEnabled() || peer.productionId == null) return true;

  const userId = peer.kind === "guest" ? peer.guestProfileUserId : peer.userId;
  return getProductionTargets(userId, peer.productionId).some((candidate) => (
    candidate?.targetType === "conference"
    && Number(candidate?.targetId) === Number(target.id)
    && candidate.canTalk !== false
  ));
}

function resolveRecipientPeersForTarget(target, speakerSocketId) {
  if (!target) return [];
  const recipients = [];
  const seen = new Set();
  const speakerPeer = ns.bridgeControl.peers.get(speakerSocketId);

  const addRecipient = (socketId, peer) => {
    if (
      !socketId
      || socketId === speakerSocketId
      || !isOperatorPeer(peer)
      || !canRouteTargetBetweenPeers(
        target,
        speakerPeer,
        peer,
        areMultipleProductionsEnabled()
      )
      || seen.has(socketId)
    ) {
      return;
    }
    seen.add(socketId);
    recipients.push({ socketId, peer });
  };

  if (target.type === "user") {
    const found = ns.companionState.findUserPeerByUserId(target.id);
    addRecipient(found?.socketId, found?.peer);
    return recipients;
  }

  if (target.type === "guest") {
    const found = findGuestPeerByGuestId(target.id);
    addRecipient(found?.socketId, found?.peer);
    return recipients;
  }

  if (target.type === "conference") {
    for (const [socketId, peer] of ns.bridgeControl.peers) {
      if (isPeerMemberOfConference(peer, target.id)) {
        addRecipient(socketId, peer);
      }
    }
  }

  return recipients;
}

function buildSpeakerReplyTarget(speakerPeer, activeTarget) {
  if (speakerPeer?.kind === "guest" && speakerPeer.guestId) {
    return {
      replyTargetType: "guest",
      replyTargetId: String(speakerPeer.guestId),
    };
  }

  if (isPersistentUserPeer(speakerPeer)) {
    const speakerUserId = Number(speakerPeer.userId);
    if (activeTarget?.type === "conference") {
      return {
        replyTargetType: "conference",
        replyTargetId: Number(activeTarget.id),
      };
    }
    return {
      replyTargetType: "user",
      replyTargetId: speakerUserId,
    };
  }

  return {};
}

function buildAddressedEntry(target, speakerPeer, fromName, at) {
  if (!target || !isOperatorPeer(speakerPeer)) {
    return null;
  }
  const speakerReplyTarget = buildSpeakerReplyTarget(speakerPeer, target);
  const fromUserId = isPersistentUserPeer(speakerPeer) ? Number(speakerPeer.userId) : null;
  const fromGuestId = speakerPeer.kind === "guest" ? String(speakerPeer.guestId || "") : null;

  if (target.type === "user") {
    return {
      fromUserId,
      fromGuestId,
      fromName: fromName || null,
      targetType: fromGuestId ? "guest" : "user",
      targetId: fromGuestId || fromUserId,
      ...speakerReplyTarget,
      at,
    };
  }

  if (target.type === "guest") {
    return {
      fromUserId,
      fromGuestId,
      fromName: fromName || null,
      targetType: fromGuestId ? "guest" : "user",
      targetId: fromGuestId || fromUserId,
      ...speakerReplyTarget,
      at,
    };
  }

  if (target.type === "conference") {
    const conferenceId = Number(target.id);
    if (!Number.isFinite(conferenceId)) {
      return null;
    }

    return {
      fromUserId,
      fromGuestId,
      fromName: fromName || null,
      targetType: "conference",
      targetId: conferenceId,
      ...speakerReplyTarget,
      at,
    };
  }

  return null;
}

function mergeAddressedNowEntry(targetMap, targetUserId, entry) {
  const key = String(targetUserId || "");
  if (!key || !entry) {
    return;
  }

  let list = targetMap.get(key);
  if (!list) {
    list = [];
    targetMap.set(key, list);
  }

  const speakerKey = entry.fromGuestId
    ? `guest:${entry.fromGuestId}`
    : Number.isFinite(Number(entry.fromUserId))
    ? Number(entry.fromUserId)
    : String(entry.fromName || "").trim().toLowerCase();
  const entryKey = `${entry.targetType}:${entry.targetId}:${speakerKey}`;
  const existingIndex = list.findIndex((candidate) => (
    `${candidate.targetType}:${candidate.targetId}:${
      candidate?.fromGuestId
        ? `guest:${candidate.fromGuestId}`
        : Number.isFinite(Number(candidate?.fromUserId))
        ? Number(candidate.fromUserId)
        : String(candidate?.fromName || "").trim().toLowerCase()
    }` === entryKey
  ));

  if (existingIndex === -1) {
    list.push(entry);
    return;
  }

  const existing = list[existingIndex];
  if (Number(entry.at) >= Number(existing?.at || 0)) {
    list[existingIndex] = entry;
  }
}

function setReplyEntry(targetMap, targetUserId, entry) {
  const key = String(targetUserId || "");
  if (!key || !entry) {
    return;
  }

  const existing = targetMap.get(key);
  if (!existing || Number(entry.at) >= Number(existing?.at || 0)) {
    targetMap.set(key, entry);
  }
}

function rememberIncomingReplyEntry(targetUserId, entry) {
  const userId = Number(targetUserId);
  if (!Number.isFinite(userId) || !entry) {
    return;
  }

  const state = ns.companionState.ensureCompanionUserState(userId);
  const existing = state.lastIncomingReplyEntry;
  if (!existing || Number(entry.at) >= Number(existing?.at || 0)) {
    state.lastIncomingReplyEntry = entry;
    state.updatedAt = Date.now();
  }
}

function buildIncomingTalkStateSnapshot() {
  const addressedNowByRecipient = new Map();
  const replyTargetByRecipient = new Map();

  for (const [speakerSocketId, peer] of ns.bridgeControl.peers) {
    if (!isOperatorPeer(peer)) continue;
    const speakerUserId = isPersistentUserPeer(peer) ? Number(peer.userId) : null;
    const base = speakerUserId !== null ? ns.companionState.ensureCompanionUserState(speakerUserId, peer?.name || null) : null;
    const activeTalk = getPeerActiveTalkInfo(peer);
    const speakerName = peer?.name || base?.userName || (speakerUserId !== null ? `User ${speakerUserId}` : "Guest");

    const activeTargets = Array.isArray(activeTalk?.targets) ? activeTalk.targets : [];
    const activeAt = Number.isFinite(Number(activeTalk?.at))
      ? Number(activeTalk.at)
      : Number(base?.updatedAt) || Date.now();

    if (activeTargets.length > 0) {
      for (const activeTarget of activeTargets) {
        if (!isTalkTargetAllowedForPeer(peer, activeTarget)) continue;
        const activeEntry = buildAddressedEntry(activeTarget, peer, speakerName, activeAt);
        if (!activeEntry) continue;
        const addressedPeers = resolveRecipientPeersForTarget(activeTarget, speakerSocketId);
        for (const addressedPeer of addressedPeers) {
          const recipientKey = getRecipientKeyForPeer(addressedPeer.peer);
          if (!recipientKey) continue;
          const canReply = activeEntry.replyTargetType !== "conference"
            || isTalkTargetAllowedForPeer(addressedPeer.peer, {
              type: "conference",
              id: activeEntry.replyTargetId,
            });
          const recipientEntry = { ...activeEntry, canReply };
          mergeAddressedNowEntry(addressedNowByRecipient, recipientKey, recipientEntry);
          setReplyEntry(replyTargetByRecipient, recipientKey, recipientEntry);
          if (isPersistentUserPeer(addressedPeer.peer)) {
            rememberIncomingReplyEntry(addressedPeer.peer.userId, recipientEntry);
          }
        }
      }
    }
  }

  for (const user of ns.companionState.getCompanionAddressableUsers()) {
    const userId = Number(user?.id);
    if (!Number.isFinite(userId)) {
      continue;
    }

    const base = ns.companionState.ensureCompanionUserState(userId, user?.name || null);
    if (base.lastIncomingReplyEntry) {
      setReplyEntry(replyTargetByRecipient, getRecipientKeyForUserId(userId), base.lastIncomingReplyEntry);
    }
  }

  return {
    addressedNowByRecipient,
    replyTargetByRecipient,
  };
}

function buildIncomingTalkStateForUser(userId, snapshot = null) {
  const normalizedUserId = Number(userId);
  const recipientKey = getRecipientKeyForUserId(normalizedUserId);
  return buildIncomingTalkStateForRecipientKey(recipientKey, snapshot);
}

function buildIncomingTalkStateForRecipientKey(recipientKey, snapshot = null) {
  const activeSnapshot = snapshot || buildIncomingTalkStateSnapshot();
  const addressedNow = recipientKey && Array.isArray(activeSnapshot?.addressedNowByRecipient?.get(recipientKey))
    ? [...activeSnapshot.addressedNowByRecipient.get(recipientKey)]
    : [];
  addressedNow.sort((left, right) => Number(right?.at || 0) - Number(left?.at || 0));

  return {
    addressedNow,
    replyTarget: recipientKey ? activeSnapshot?.replyTargetByRecipient?.get(recipientKey) || null : null,
  };
}

function sanitizeCompanionIncomingEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.targetType !== "user" && entry.targetType !== "conference") {
    return null;
  }
  const targetId = Number(entry.targetId);
  if (!Number.isFinite(targetId)) {
    return null;
  }
  return {
    targetType: entry.targetType,
    targetId,
    fromUserId: Number.isFinite(Number(entry.fromUserId)) ? Number(entry.fromUserId) : null,
    fromName: entry.fromName || null,
    at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
  };
}

function sanitizeCompanionIncomingTalkState(state) {
  const addressedNow = (Array.isArray(state?.addressedNow) ? state.addressedNow : [])
    .map(sanitizeCompanionIncomingEntry)
    .filter(Boolean);
  return {
    addressedNow,
    replyTarget: sanitizeCompanionIncomingEntry(state?.replyTarget),
  };
}

function parseCompanionWaitMs(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return COMPANION_DEFAULT_WAIT_MS;
  }
  return Math.min(COMPANION_MAX_WAIT_MS, Math.max(100, Math.round(parsed)));
}
Object.assign(ns.talkTargets, {
  arePeersInSameActiveProduction,
  buildIncomingTalkStateForRecipientKey,
  buildIncomingTalkStateForUser,
  buildIncomingTalkStateSnapshot,
  findGuestPeerByGuestId,
  getPeerActiveTalkInfo,
  getPeerActiveTalkProducers,
  getPeerActiveTalkTargets,
  getPeerTalkProducers,
  getRecipientKeyForPeer,
  isOperatorPeer,
  isPeerMemberOfConference,
  isPersistentUserPeer,
  isTalkTargetAllowedForPeer,
  normalizeCompanionTargetAudioStates,
  normalizeCompanionVisibleRuntimeTalkTarget,
  normalizeCompanionVisibleRuntimeTalkTargets,
  normalizeRuntimeTalkTarget,
  normalizeRuntimeTalkTargets,
  parseCompanionWaitMs,
  resolveRecipientPeersForTarget,
  sanitizeCompanionIncomingTalkState,
});
