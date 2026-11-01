/**
 * LinkTalk server — состояние Companion, команды и их доставка
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const crypto = require("crypto");
const { getAllUsers, getUserById, getAllConferences, getAllFeeds, getProductionById, getPrimaryProduction, isUserInProduction, getProductionMembers, getProductionConferences, getProductionFeeds, getProductionUsersForConference, getProductionTargets, getUserTargetAudioStates } = require("../dbHandler");
const ns = require("../ns");
const { scheduleAdminStatusBroadcast } = ns.sessions;
const { COMPANION_DEFAULT_VOLUME_STEP, COMPANION_PENDING_TTL_MS, buildCompanionAuthScope, companionPendingCommands, companionUserState } = ns.companionAuth;
const { buildIncomingTalkStateForRecipientKey, buildIncomingTalkStateForUser, buildIncomingTalkStateSnapshot, getPeerActiveTalkInfo, getRecipientKeyForPeer, isOperatorPeer, isPersistentUserPeer, normalizeCompanionTargetAudioStates, normalizeCompanionVisibleRuntimeTalkTarget, normalizeCompanionVisibleRuntimeTalkTargets, sanitizeCompanionIncomingTalkState } = ns.talkTargets;

function resolveLegacyAllConferenceId() {
  const legacy = (getAllConferences() || []).find((conference) => (
    String(conference?.name || '').trim().toLowerCase() === 'all'
  ));
  const id = Number(legacy?.id);
  return Number.isFinite(id) ? id : null;
}

function normalizeTalkCommandInput(input = {}) {
  let { action, targetType = "conference", targetId = null, inputKey = null } = input || {};

  if (!["press", "release", "lock-toggle"].includes(action)) {
    return { ok: false, status: 400, error: "action must be press, release, or lock-toggle" };
  }

  const normalizedType = typeof targetType === "string" ? targetType.trim().toLowerCase() : "conference";
  targetType = normalizedType;

  if (targetType === "reply") {
    targetId = undefined;
  } else {
    const isLegacyAllTarget = targetType === "all" || targetType === "global";
    if (isLegacyAllTarget) {
      const allConferenceId = resolveLegacyAllConferenceId();
      if (allConferenceId === null) {
        return {
          ok: false,
          status: 404,
          error: "Conference 'All' not found. Create a conference and select it explicitly.",
        };
      }
      targetType = "conference";
      targetId = allConferenceId;
    }

    if (targetType === "conference" || targetType === "user") {
      const numericTargetId = Number(targetId);
      if (!Number.isFinite(numericTargetId)) {
        const errorLabel = targetType === "conference" ? "conference" : "user";
        return { ok: false, status: 400, error: `Invalid ${errorLabel} id` };
      }
      targetId = numericTargetId;
    } else {
      return { ok: false, status: 400, error: "targetType must be conference, user, or reply" };
    }
  }

  const normalizedInputKey = typeof inputKey === "string" ? inputKey.trim() : "";
  const payload = targetType === "reply"
    ? { action, targetType }
    : { action, targetType, targetId };
  if (normalizedInputKey) {
    payload.inputKey = normalizedInputKey;
  }

  return { ok: true, value: { action, targetType, targetId, payload } };
}

function normalizeTargetAudioCommandInput(input = {}) {
  let { action, targetType = "conference", targetId = null, step = COMPANION_DEFAULT_VOLUME_STEP } = input || {};

  if (!["volume-up", "volume-down", "mute-toggle"].includes(action)) {
    return {
      ok: false,
      status: 400,
      error: "action must be volume-up, volume-down, or mute-toggle",
    };
  }

  const normalizedType = typeof targetType === "string" ? targetType.trim().toLowerCase() : "conference";
  targetType = normalizedType;
  if (!["conference", "user", "feed"].includes(targetType)) {
    return { ok: false, status: 400, error: "targetType must be conference, user, or feed" };
  }

  const numericTargetId = Number(targetId);
  if (!Number.isFinite(numericTargetId)) {
    return { ok: false, status: 400, error: `Invalid ${targetType} id` };
  }
  targetId = numericTargetId;

  let normalizedStep = null;
  if (action === "volume-up" || action === "volume-down") {
    const requestedStep = Number(step);
    const safeStep = Number.isFinite(requestedStep) ? requestedStep : COMPANION_DEFAULT_VOLUME_STEP;
    normalizedStep = Math.min(1, Math.max(0.01, safeStep));
  }

  const payload = { action, targetType, targetId };
  if (normalizedStep !== null) {
    payload.step = normalizedStep;
  }

  return { ok: true, value: { action, targetType, targetId, step: normalizedStep, payload } };
}

function findUserPeerByUserId(userId) {
  const key = String(userId);
  for (const [socketId, peer] of ns.bridgeControl.peers) {
    if (peer?.kind === "user" && peer.userId != null && String(peer.userId) === key) {
      return { socketId, peer };
    }
  }
  return null;
}

function findFeedPeerByFeedId(feedId) {
  const key = String(feedId);
  for (const [socketId, peer] of ns.bridgeControl.peers) {
    if (peer?.kind === "feed" && peer.feedId != null && String(peer.feedId) === key) {
      return { socketId, peer };
    }
  }
  return null;
}

function disconnectUserPeerForLogout({ userId = null, socketId = null } = {}) {
  const normalizedUserId = Number(userId);
  const hasUserId = Number.isFinite(normalizedUserId);
  const normalizedSocketId =
    typeof socketId === "string" && socketId.trim() ? socketId.trim() : null;

  let target = null;
  if (normalizedSocketId) {
    const peer = ns.bridgeControl.peers.get(normalizedSocketId);
    if (!peer || peer.kind !== "user") {
      return false;
    }
    if (hasUserId && String(peer.userId) !== String(normalizedUserId)) {
      return false;
    }
    target = { socketId: normalizedSocketId, peer };
  }

  if (!target && hasUserId) {
    target = findUserPeerByUserId(normalizedUserId);
  }

  if (!target) {
    return false;
  }

  try {
    target.peer?.socket?.disconnect(true);
  } catch {}
  return true;
}

function getPeerActiveTalkTarget(peer) {
  return getPeerActiveTalkInfo(peer)?.target || null;
}

function ensureCompanionUserState(userId, fallbackName = null) {
  const key = String(userId);
  let state = companionUserState.get(key);
  if (!state) {
    const persistedTargetAudioStates = getUserTargetAudioStates(userId);
    state = {
      userId,
      userName: fallbackName || null,
      online: false,
      socketId: null,
      talking: false,
      talkLocked: false,
      currentTarget: null,
      currentTargets: [],
      lastTarget: null,
      lastTargets: [],
      lastIncomingReplyEntry: null,
      targetAudioStates: persistedTargetAudioStates,
      lastSpokeAt: null,
      lastCommandId: null,
      lastCommandResult: null,
      updatedAt: Date.now(),
    };
    companionUserState.set(key, state);
  } else if (fallbackName && !state.userName) {
    state.userName = fallbackName;
  }
  return state;
}

function buildCompanionUserState(userId, fallbackName = null, incomingSnapshot = null, productionId = null) {
  const base = ensureCompanionUserState(userId, fallbackName);
  const found = findUserPeerByUserId(userId);
  const peer = found?.peer || null;
  const socketId = found?.socketId || null;
  const activeTalkInfo = peer ? getPeerActiveTalkInfo(peer) : null;
  const activeRuntimeTargets = Array.isArray(activeTalkInfo?.targets) ? activeTalkInfo.targets : [];
  const activeTargets = normalizeCompanionVisibleRuntimeTalkTargets(activeRuntimeTargets);
  const activeTarget = normalizeCompanionVisibleRuntimeTalkTarget(activeTalkInfo?.target) || activeTargets[0] || null;
  const currentTarget = activeTarget || null;
  const talking = Boolean(found && activeTargets.length > 0);
  const resolvedName = peer?.name || base.userName || fallbackName || null;
  const lastTargets = normalizeCompanionVisibleRuntimeTalkTargets(base.lastTargets);
  const lastTarget = normalizeCompanionVisibleRuntimeTalkTarget(base.lastTarget) || lastTargets[0] || currentTarget || null;
  const incomingTalkState = sanitizeCompanionIncomingTalkState(buildIncomingTalkStateForUser(userId, incomingSnapshot));
  const tally = ns.listenConfig.getTallyState(productionId);

  return {
    userId,
    name: resolvedName,
    socketId,
    online: Boolean(found),
    talking,
    talkLocked: Boolean(base.talkLocked && found),
    currentTarget: talking ? currentTarget : null,
    currentTargets: talking ? activeTargets : [],
    lastTarget,
    lastTargets: lastTargets.length > 0 ? lastTargets : (lastTarget ? [lastTarget] : []),
    lastSpokeAt: base.lastSpokeAt || null,
    cutCamera: Boolean(resolvedName && tally.pgmUser === resolvedName),
    previewCamera: Boolean(resolvedName && tally.prvUser === resolvedName),
    lastCommandId: base.lastCommandId || null,
    lastCommandResult: base.lastCommandResult || null,
    targetAudioStates: normalizeCompanionTargetAudioStates(base.targetAudioStates),
    addressedNow: incomingTalkState.addressedNow,
    replyTarget: incomingTalkState.replyTarget,
    updatedAt: base.updatedAt || null,
  };
}

function buildOperatorTargetsForUser(userId, productionId = null) {
  const numericProductionId = productionId === null || productionId === undefined || productionId === ""
    ? Number(getPrimaryProduction()?.id)
    : Number(productionId);
  if (Number.isFinite(numericProductionId)) {
    if (!Number.isFinite(numericProductionId) || !isUserInProduction(userId, numericProductionId)) {
      const error = new Error("User is not a member of this production");
      error.statusCode = 403;
      throw error;
    }
  }

  const targets = Number.isFinite(numericProductionId)
    ? (getProductionTargets(userId, numericProductionId) || [])
    : [];

  return targets.map((target) => {
    if (target?.targetType !== "conference") {
      return target;
    }

    const conferenceId = Number(target.targetId);
    const members = Number.isFinite(conferenceId)
      ? (Number.isFinite(numericProductionId)
        ? getProductionUsersForConference(conferenceId, numericProductionId)
        : []
      ).map((member) => ({
        userId: Number(member.id),
        name: member.name || String(member.id),
      }))
      : [];

    return {
      ...target,
      canTalk: target.canTalk !== false && Number(target.canTalk) !== 0,
      members,
    };
  });
}

function filterSystemInternalTargets(targets = []) {
  return Array.isArray(targets) ? targets : [];
}

function isCompanionAddressableUser(user) {
  return Boolean(user && !user.is_superadmin && !user.is_guest_profile);
}

function isCompanionAddressableUserId(userId) {
  const user = getUserById(userId);
  return isCompanionAddressableUser(user);
}

function getCompanionAddressableUsers() {
  return getAllUsers().filter(isCompanionAddressableUser);
}

function buildCompanionSnapshot(productionId = null) {
  const incomingSnapshot = buildIncomingTalkStateSnapshot();
  const productionMemberIds = productionId === null
    ? null
    : new Set(getProductionMembers(productionId).map((member) => Number(member.id)));
  const users = getCompanionAddressableUsers()
    .filter((user) => productionMemberIds === null || productionMemberIds.has(Number(user.id)))
    .map((user) => ({
    id: user.id,
    name: user.name,
    state: buildCompanionUserState(user.id, user.name, incomingSnapshot, productionId),
  }));

  return {
    version: 1,
    serverTime: new Date().toISOString(),
    cutCameraUser: ns.listenConfig.getTallyState(productionId).pgmUser,
    previewCameraUser: ns.listenConfig.getTallyState(productionId).prvUser,
    tally: {
      productionId,
      ...ns.listenConfig.getTallyState(productionId),
    },
    users,
    conferences: productionId === null ? getAllConferences() : getProductionConferences(productionId),
    feeds: productionId === null ? getAllFeeds() : getProductionFeeds(productionId),
    production: productionId === null ? null : getProductionById(productionId),
  };
}

function buildCompanionSnapshotForAuth(auth, productionId = null) {
  return {
    ...buildCompanionSnapshot(productionId),
    scope: buildCompanionAuthScope(auth),
  };
}

function emitCompanionEvent(event, payload = {}) {
  if (!ns.companionAuth.companionNamespace) return;
  for (const socket of ns.companionAuth.companionNamespace.sockets.values()) {
    const productionId = socket.data?.productionId ?? null;
    if (productionId === null) {
      socket.emit(event, payload);
      continue;
    }
    const userId = Number(payload?.userId ?? payload?.state?.userId ?? payload?.state?.id);
    if (Number.isFinite(userId) && !isUserInProduction(userId, productionId)) continue;
    socket.emit(event, payload);
  }
}

function emitCompanionUserState(userId, reason = "state-updated", fallbackName = null, incomingSnapshot = null) {
  if (!isCompanionAddressableUserId(userId)) return;
  if (!ns.companionAuth.companionNamespace) return;
  for (const socket of ns.companionAuth.companionNamespace.sockets.values()) {
    const productionId = socket.data?.productionId ?? ns.listenConfig.getDefaultTallyProductionId();
    if (productionId !== null && !isUserInProduction(userId, productionId)) continue;
    socket.emit("user-state", {
      reason,
      at: new Date().toISOString(),
      state: buildCompanionUserState(userId, fallbackName, incomingSnapshot, productionId),
    });
  }
}

function updateCompanionUserState(userId, patch = {}, { reason = "state-updated", fallbackName = null } = {}) {
  if (userId === null || userId === undefined) return;
  if (!isCompanionAddressableUserId(userId)) return;
  const state = ensureCompanionUserState(userId, fallbackName);
  const normalizedPatch = { ...patch };
  if ("targetAudioStates" in normalizedPatch) {
    normalizedPatch.targetAudioStates = normalizeCompanionTargetAudioStates(normalizedPatch.targetAudioStates);
  }
  Object.assign(state, normalizedPatch, { userId, updatedAt: Date.now() });
  if (fallbackName && !state.userName) {
    state.userName = fallbackName;
  }
  emitCompanionUserState(userId, reason, fallbackName);
}

function syncPeerCompanionState(peer, { reason = "peer-sync" } = {}) {
  if (!peer || peer.kind !== "user" || peer.userId === null || peer.userId === undefined) {
    return;
  }
  const activeTalkInfo = getPeerActiveTalkInfo(peer);
  const activeRuntimeTargets = Array.isArray(activeTalkInfo?.targets) ? activeTalkInfo.targets : [];
  const activeTargets = normalizeCompanionVisibleRuntimeTalkTargets(activeRuntimeTargets);
  const activeTarget = normalizeCompanionVisibleRuntimeTalkTarget(activeTalkInfo?.target) || activeTargets[0] || null;
  const patch = {
    userName: peer.name || null,
    online: true,
    socketId: peer.socket?.id || null,
    talking: activeTargets.length > 0,
    currentTarget: activeTarget,
    currentTargets: activeTargets,
  };
  if (activeTarget) {
    patch.lastTarget = activeTarget;
    patch.lastTargets = activeTargets;
  } else {
    patch.talkLocked = false;
    patch.lastSpokeAt = Date.now();
  }
  updateCompanionUserState(peer.userId, patch, { reason, fallbackName: peer.name || null });
}

function emitClientIncomingTalkState(peer, reason = "incoming-talk-state", incomingSnapshot = null) {
  if (!isOperatorPeer(peer)) {
    return;
  }
  const recipientKey = getRecipientKeyForPeer(peer);
  if (!recipientKey) return;

  peer.socket.emit("incoming-talk-state", {
    reason,
    at: new Date().toISOString(),
    state: {
      userId: isPersistentUserPeer(peer) ? Number(peer.userId) : null,
      guestId: peer.kind === "guest" ? String(peer.guestId || "") : null,
      ...buildIncomingTalkStateForRecipientKey(recipientKey, incomingSnapshot),
    },
  });
}

function broadcastRuntimeUserStates(reason = "runtime-state-changed") {
  const incomingSnapshot = buildIncomingTalkStateSnapshot();

  for (const [, peer] of ns.bridgeControl.peers) {
    if (!isOperatorPeer(peer)) {
      continue;
    }
    emitClientIncomingTalkState(peer, reason, incomingSnapshot);
  }

  for (const user of getCompanionAddressableUsers()) {
    emitCompanionUserState(user.id, reason, user.name, incomingSnapshot);
  }
  scheduleAdminStatusBroadcast(reason);
}

function registerCompanionPendingCommand(meta = {}) {
  const commandId = meta.commandId || crypto.randomUUID();
  let resolvePromise = () => {};
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  const expiresAt = Date.now() + COMPANION_PENDING_TTL_MS;
  const expiryTimer = setTimeout(() => {
    const entry = companionPendingCommands.get(commandId);
    if (!entry) return;
    companionPendingCommands.delete(commandId);
    const timeoutPayload = {
      commandId,
      ok: false,
      reason: "result-timeout",
      timedOut: true,
      userId: entry.userId ?? null,
      at: new Date().toISOString(),
    };
    entry.resolve(timeoutPayload);
    emitCompanionEvent("command-result", timeoutPayload);
  }, COMPANION_PENDING_TTL_MS);

  companionPendingCommands.set(commandId, {
    ...meta,
    commandId,
    expiresAt,
    expiryTimer,
    resolve: resolvePromise,
  });

  return { commandId, promise };
}

function settleCompanionPendingCommand(commandId, payload = {}) {
  const entry = companionPendingCommands.get(commandId);
  if (!entry) return false;

  companionPendingCommands.delete(commandId);
  clearTimeout(entry.expiryTimer);
  entry.resolve({
    commandId,
    userId: entry.userId ?? null,
    ...payload,
  });
  return true;
}

function failPendingCommandsForUser(userId, reason = "user-disconnected") {
  const nowIso = new Date().toISOString();
  for (const [commandId, entry] of companionPendingCommands.entries()) {
    if (String(entry.userId) !== String(userId)) continue;
    companionPendingCommands.delete(commandId);
    clearTimeout(entry.expiryTimer);
    const payload = {
      commandId,
      userId: entry.userId ?? null,
      ok: false,
      reason,
      at: nowIso,
    };
    entry.resolve(payload);
    emitCompanionEvent("command-result", payload);
  }
}

function dispatchCompanionCommandToUser(userId, socketEvent, payload, { commandId = null } = {}) {
  const target = findUserPeerByUserId(userId);
  if (!target) {
    return { ok: false, status: 404, error: "user not connected" };
  }

  const message = { ...payload };
  if (commandId) {
    message.commandId = commandId;
    message.sentAt = new Date().toISOString();
    updateCompanionUserState(target.peer.userId, {
      lastCommandId: commandId,
      lastCommandResult: "pending",
    }, {
      reason: "command-dispatched",
      fallbackName: target.peer.name || null,
    });
  }

  target.peer.socket.emit(socketEvent, message);
  return { ok: true, socketId: target.socketId, peer: target.peer };
}

function dispatchTalkCommandToUser(userId, payload, options = {}) {
  return dispatchCompanionCommandToUser(userId, "api-talk-command", payload, options);
}

function dispatchTargetAudioCommandToUser(userId, payload, options = {}) {
  return dispatchCompanionCommandToUser(userId, "api-target-audio-command", payload, options);
}
Object.assign(ns.companionState, {
  broadcastRuntimeUserStates,
  buildCompanionSnapshotForAuth,
  buildCompanionUserState,
  buildOperatorTargetsForUser,
  disconnectUserPeerForLogout,
  dispatchTalkCommandToUser,
  dispatchTargetAudioCommandToUser,
  emitCompanionEvent,
  emitCompanionUserState,
  ensureCompanionUserState,
  failPendingCommandsForUser,
  findFeedPeerByFeedId,
  findUserPeerByUserId,
  getCompanionAddressableUsers,
  isCompanionAddressableUser,
  isCompanionAddressableUserId,
  normalizeTalkCommandInput,
  normalizeTargetAudioCommandInput,
  registerCompanionPendingCommand,
  settleCompanionPendingCommand,
  syncPeerCompanionState,
  updateCompanionUserState,
});
