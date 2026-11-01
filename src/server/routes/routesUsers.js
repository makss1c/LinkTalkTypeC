/**
 * LinkTalk server — маршруты пользователей, конференций и целей
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { resolveDefaultClientSettings } = require("../defaultClientSettings");
const { canUserRearrangeTargets, validateCompleteTargetOrder } = require("../targetOrdering");
const { normalize: normalizeUserAudioSettings, resolve: resolveUserAudioSettings } = require("../../../public/userAudioSettings");
const { getAllUsers, getUserById, getUserAudioSettings, updateUserAudioSettings, updateUserTargetRearrangePermission, getAllConferences, getAllFeeds, getPrimaryProduction, isUserInProduction, getProductionConferencesForUser, getProductionUsersForConference, getProductionTargets, updateProductionTargetOrder, getUserTargets } = require("../dbHandler");
const ns = require("../ns");
const { app } = ns.base;
const { areMultipleProductionsEnabled, getEnabledProductionsForUser, getSingleProductionMembershipScope, loadRuntimeConfig, resolveGuestLoginSettings } = ns.config;
const { getBrowserSession, requireAdmin } = ns.sessions;
const { buildOperatorTargetsForUser, findUserPeerByUserId } = ns.companionState;

// === GET ===
app.get("/users", requireAdmin, (req, res) => {
  const defaults = resolveDefaultClientSettings((loadRuntimeConfig() || {}).defaultClientSettings);
  res.json(getAllUsers().map(user => ({
    ...user,
    allowTargetRearrange: canUserRearrangeTargets(user, defaults),
  })));
});

function isTargetRearrangeAllowed(user) {
  return canUserRearrangeTargets(user, (loadRuntimeConfig() || {}).defaultClientSettings);
}

function emitTargetRearrangePermission(user) {
  findUserPeerByUserId(user.id)?.peer?.socket?.emit('target-rearrange-permission-updated', {
    allowed: isTargetRearrangeAllowed(user),
  });
}

app.put('/admin/users/:id/target-rearrange', requireAdmin, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user || user.is_superadmin) return res.status(404).json({ error: 'User not found' });
  const allowed = req.body?.allowTargetRearrange;
  if (allowed !== null && typeof allowed !== 'boolean') {
    return res.status(400).json({ error: 'allowTargetRearrange must be boolean or null' });
  }
  updateUserTargetRearrangePermission(user.id, allowed);
  const updated = getUserById(user.id);
  emitTargetRearrangePermission(updated);
  res.json({ ok: true, allowTargetRearrange: isTargetRearrangeAllowed(updated) });
});

function getResolvedUserAudioSettings(userId) {
  const config = loadRuntimeConfig() || {};
  return resolveUserAudioSettings(
    getUserAudioSettings(userId) || {},
    resolveDefaultClientSettings(config.defaultClientSettings)
  );
}

function getUserAudioSettingTargets(userId) {
  const productions = getEnabledProductionsForUser(userId);
  const source = productions.length
    ? productions.flatMap((production) => getProductionTargets(userId, production.id))
    : getUserTargets(userId);
  const unique = new Map();
  source
    .filter((target) => ['user', 'conference'].includes(target.targetType) && target.canTalk !== false)
    .forEach((target) => unique.set(`${target.targetType}:${target.targetId}`, {
      id: Number(target.targetId),
      type: target.targetType,
      name: target.name,
    }));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

app.get('/admin/users/:id/audio-settings', requireAdmin, (req, res) => {
  const user = getUserById(req.params.id);
  if (!user || user.is_superadmin || user.is_guest_profile) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({
    settings: getResolvedUserAudioSettings(user.id),
    targets: getUserAudioSettingTargets(user.id),
    configuredAsBridge: Boolean(user.bridge_enabled),
  });
});

app.put('/admin/users/:id/audio-settings', requireAdmin, (req, res) => {
  try {
    const user = getUserById(req.params.id);
    if (!user || user.is_superadmin || user.is_guest_profile) {
      return res.status(404).json({ error: 'User not found' });
    }
    const settings = normalizeUserAudioSettings(req.body?.settings, { strict: true });
    updateUserAudioSettings(user.id, settings);
    const resolved = getResolvedUserAudioSettings(user.id);
    findUserPeerByUserId(user.id)?.peer?.socket?.emit('user-audio-settings-updated', { settings: resolved });
    res.json({ ok: true, settings: resolved });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Invalid audio settings' });
  }
});

app.get("/conferences", requireAdmin, (req, res) => {
  res.json(getAllConferences());
});

app.get("/feeds", requireAdmin, (req, res) => {
  res.json(getAllFeeds());
});

app.get("/users/:id/conferences", requireAdmin, (req, res) => {
  try {
    const productionId = getSingleProductionMembershipScope();
    const conferences = getProductionConferencesForUser(req.params.id, productionId);
    res.json(conferences);
  } catch (err) {
    console.error(err);
    res.status(err?.statusCode || 500).json({ error: err.message || "Internal server error" });
  }
});

app.get('/conferences/:id/users', requireAdmin, (req, res) => {
  const confId = req.params.id;
  try {
    const productionId = getSingleProductionMembershipScope();
    const users = getProductionUsersForConference(confId, productionId);
    res.json(users);
  } catch (err) {
    console.error(`[ERROR] fetching users for conference ${confId}:`, err);
    res.status(err?.statusCode || 500).json({ error: err.message });
  }
});


app.get('/users/:id/targets', (req, res) => {
  try {
    const includeMemberships = ["1", "true", "yes", "on"].includes(
      String(req.query?.includeMemberships || "").trim().toLowerCase()
    );
    const productionId = areMultipleProductionsEnabled()
      ? (req.query?.productionId ?? null)
      : (getPrimaryProduction()?.id ?? null);
    if (productionId !== null && productionId !== undefined && productionId !== "") {
      if (!isUserInProduction(req.params.id, productionId)) {
        return res.status(403).json({ error: "User is not a member of this production" });
      }
    }
    const targets = includeMemberships
      ? buildOperatorTargetsForUser(req.params.id, productionId)
      : productionId === null || productionId === undefined || productionId === ""
        ? getUserTargets(req.params.id)
        : getProductionTargets(req.params.id, productionId);
    res.json(targets);
  } catch (err) {
    res.status(err?.statusCode || 500).json({ error: err.message });
  }
});

app.put('/api/v1/client/targets/order', (req, res) => {
  const browserSession = getBrowserSession(req)?.session;
  if (browserSession?.kind !== 'user') {
    return res.status(401).json({ error: 'User login required' });
  }
  const userId = Number(browserSession.userId);
  const user = getUserById(userId);
  if (!isTargetRearrangeAllowed(user)) {
    return res.status(403).json({ error: 'User cannot arrange targets' });
  }

  const productionId = areMultipleProductionsEnabled()
    ? Number(req.body?.productionId)
    : Number(getPrimaryProduction()?.id);
  if (!Number.isSafeInteger(productionId) || productionId < 1) {
    return res.status(400).json({ error: 'Select a production first' });
  }
  if (!isUserInProduction(userId, productionId)) {
    return res.status(403).json({ error: 'User is not a member of this production' });
  }

  try {
    const currentTargets = getProductionTargets(userId, productionId);
    const items = validateCompleteTargetOrder(req.body?.items, currentTargets);
    updateProductionTargetOrder(productionId, userId, items);
    ns.entityNotifications.notifyTargetChange(userId);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || 'Failed to arrange targets' });
  }
});

app.get('/users/:id/productions', (req, res) => {
  try {
    const user = getUserById(req.params.id);
    if (!user || user.is_superadmin) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(getEnabledProductionsForUser(req.params.id).map(({ id, name }) => ({ id, name })));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load productions' });
  }
});

app.get("/guest/targets", (req, res) => {
  try {
    const settings = resolveGuestLoginSettings(loadRuntimeConfig() || {}, { createProfile: false });
    if (!settings.enabled || !settings.profileUserId) {
      return res.status(403).json({ error: "Guest login is disabled" });
    }
    res.json(buildOperatorTargetsForUser(settings.profileUserId, req.query?.productionId ?? null));
  } catch (err) {
    console.error("Guest targets error:", err);
    res.status(500).json({ error: err.message || "Failed to load guest targets" });
  }
});
Object.assign(ns.routesUsers, {
  emitTargetRearrangePermission,
  getResolvedUserAudioSettings,
  isTargetRearrangeAllowed,
});
