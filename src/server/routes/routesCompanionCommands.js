/**
 * LinkTalk server — команды Companion и выход клиента
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const crypto = require("crypto");
const { getUserById, isUserInProduction, getProductionTargets, getUserTargets } = require("../dbHandler");
const ns = require("../ns");
const { app } = ns.base;
const { clearBrowserSession } = ns.sessions;
const { COMPANION_DEFAULT_WAIT_MS, canCompanionControlUser, requireCompanionApiKey, resolveCompanionProduction } = ns.companionAuth;
const { parseCompanionWaitMs } = ns.talkTargets;
const { disconnectUserPeerForLogout, dispatchTalkCommandToUser, dispatchTargetAudioCommandToUser, emitCompanionEvent, failPendingCommandsForUser, findUserPeerByUserId, isCompanionAddressableUserId, normalizeTalkCommandInput, normalizeTargetAudioCommandInput, registerCompanionPendingCommand, settleCompanionPendingCommand, updateCompanionUserState } = ns.companionState;

app.get("/api/v1/companion/users/:id/targets", requireCompanionApiKey, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  if (!isCompanionAddressableUserId(userId)) {
    return res.status(404).json({ error: "User not found" });
  }
  if (!canCompanionControlUser(req.companionAuth, userId)) {
    return res.status(403).json({ error: "Companion session cannot access this user" });
  }
  try {
    const productionId = resolveCompanionProduction(req.companionAuth, req.query?.productionId);
    if (productionId !== null && !isUserInProduction(userId, productionId)) {
      return res.status(403).json({ error: "User is not a member of this production" });
    }
    const targets = productionId === null
      ? getUserTargets(userId)
      : getProductionTargets(userId, productionId);
    res.json(targets);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post("/api/v1/client/logout", (req, res) => {
  clearBrowserSession(req, res);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const userId = Number(body.userId);
  const socketId = typeof body.socketId === "string" ? body.socketId : null;

  if (!Number.isFinite(userId)) {
    return res.sendStatus(204);
  }

  const disconnected = socketId
    ? disconnectUserPeerForLogout({ userId, socketId })
    : false;

  // Fallback: if no live peer was found, reflect offline immediately for companion.
  if (
    !disconnected
    && !socketId
    && !findUserPeerByUserId(userId)
    && isCompanionAddressableUserId(userId)
  ) {
    const userName = getUserById(userId)?.name || null;
    updateCompanionUserState(
      userId,
      {
        userName,
        online: false,
        socketId: null,
        talking: false,
        talkLocked: false,
        currentTarget: null,
        currentTargets: [],
        targetAudioStates: [],
        lastSpokeAt: Date.now(),
      },
      {
        reason: "client-logout-http",
        fallbackName: userName,
      }
    );
    failPendingCommandsForUser(userId, "user-logout");
  }

  return res.sendStatus(204);
});

app.post("/api/v1/companion/users/:id/talk", requireCompanionApiKey, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  if (!canCompanionControlUser(req.companionAuth, userId)) {
    return res.status(403).json({ error: "Forbidden for this companion account" });
  }
  if (!isCompanionAddressableUserId(userId)) {
    return res.status(404).json({ error: "User not found" });
  }

  const normalized = normalizeTalkCommandInput(req.body || {});
  if (!normalized.ok) {
    return res.status(normalized.status).json({ error: normalized.error });
  }

  const waitMs = parseCompanionWaitMs(
    req.query?.waitMs ?? req.body?.waitMs ?? COMPANION_DEFAULT_WAIT_MS
  );
  const commandId = crypto.randomUUID();
  const { promise } = registerCompanionPendingCommand({
    commandId,
    userId,
    action: normalized.value.action,
    targetType: normalized.value.targetType,
    targetId: normalized.value.targetId,
  });

  const dispatch = dispatchTalkCommandToUser(userId, normalized.value.payload, { commandId });
  if (!dispatch.ok) {
    const failedPayload = {
      ok: false,
      reason: dispatch.error || "dispatch-failed",
      at: new Date().toISOString(),
    };
    settleCompanionPendingCommand(commandId, failedPayload);
    emitCompanionEvent("command-result", {
      commandId,
      userId,
      ...failedPayload,
    });
    return res.status(dispatch.status || 500).json({ error: dispatch.error || "Dispatch failed" });
  }

  const result = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), waitMs)),
  ]);

  if (!result) {
    return res.status(202).json({
      commandId,
      status: "pending",
      waitMs,
      accepted: true,
    });
  }

  const responsePayload = {
    commandId,
    status: result.ok ? "ok" : "failed",
    accepted: true,
    result,
  };
  return res.status(result.ok ? 200 : 409).json(responsePayload);
});

app.post("/api/v1/companion/users/:id/target-audio", requireCompanionApiKey, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: "Invalid user id" });
  }
  if (!canCompanionControlUser(req.companionAuth, userId)) {
    return res.status(403).json({ error: "Forbidden for this companion account" });
  }
  if (!isCompanionAddressableUserId(userId)) {
    return res.status(404).json({ error: "User not found" });
  }

  const normalized = normalizeTargetAudioCommandInput(req.body || {});
  if (!normalized.ok) {
    return res.status(normalized.status).json({ error: normalized.error });
  }

  const waitMs = parseCompanionWaitMs(
    req.query?.waitMs ?? req.body?.waitMs ?? COMPANION_DEFAULT_WAIT_MS
  );
  const commandId = crypto.randomUUID();
  const { promise } = registerCompanionPendingCommand({
    commandId,
    userId,
    action: normalized.value.action,
    targetType: normalized.value.targetType,
    targetId: normalized.value.targetId,
  });

  const dispatch = dispatchTargetAudioCommandToUser(userId, normalized.value.payload, { commandId });
  if (!dispatch.ok) {
    const failedPayload = {
      ok: false,
      reason: dispatch.error || "dispatch-failed",
      at: new Date().toISOString(),
    };
    settleCompanionPendingCommand(commandId, failedPayload);
    emitCompanionEvent("command-result", {
      commandId,
      userId,
      ...failedPayload,
    });
    return res.status(dispatch.status || 500).json({ error: dispatch.error || "Dispatch failed" });
  }

  const result = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), waitMs)),
  ]);

  if (!result) {
    return res.status(202).json({
      commandId,
      status: "pending",
      waitMs,
      accepted: true,
    });
  }

  const responsePayload = {
    commandId,
    status: result.ok ? "ok" : "failed",
    accepted: true,
    result,
  };
  return res.status(result.ok ? 200 : 409).json(responsePayload);
});