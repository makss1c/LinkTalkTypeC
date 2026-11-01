/**
 * LinkTalk server — управление пользователями, фидами, конференциями
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const QRCode = require("qrcode");
const { buildGuestLoginUrl, buildLoginUrl } = require("../qrConnectUrl");
const { createUser, createConference, createFeed, createFeedLoginToken, createUserLoginToken, updateAdminPassword, getUserById, setProductionConferenceMembership, addProductionTarget, updateProductionTargetOrder, verifyUser, setUserAdminRole } = require("../dbHandler");
const ns = require("../ns");
const { app } = ns.base;
const { addEntityToPrimaryProductionWhenSingle, getEnabledProductionsForUser, getSingleProductionMembershipScope, loadRuntimeConfig, resolveGuestLoginSettings, resolveTransportAnnouncedAddress } = ns.config;
const { requireAdmin, requireAdminSession, scheduleAdminStatusBroadcast } = ns.sessions;
const { COMPANION_SESSION_TTL_MS, createCompanionSession } = ns.companionAuth;
const { broadcastRuntimeUserStates } = ns.companionState;
const { resolveAdminConnectUrl } = ns.adminSettings;

app.post("/api/v1/companion/auth/login", (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) {
    return res.status(400).json({ error: "Name and password are required" });
  }

  try {
    const user = verifyUser(name, password);
    if (!user || user.is_guest_profile) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = createCompanionSession(user);
    const scope = user.is_superadmin ? "all" : "self";
    return res.json({
      token,
      expiresInMs: COMPANION_SESSION_TTL_MS,
      user: {
        id: user.id,
        name: user.name,
        isAdmin: !!user.is_admin,
        isSuperadmin: !!user.is_superadmin,
      },
      productions: getEnabledProductionsForUser(user.id).map(({ id, name: productionName }) => ({
        id,
        name: productionName,
      })),
      scope: {
        mode: scope,
        userId: user.id,
      },
    });
  } catch (err) {
    console.error("Companion auth login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/admin/password", requireAdminSession, (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== "string" || password.trim().length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters" });
  }

  try {
    const updated = updateAdminPassword(req.adminSession.userId, password.trim());
    if (!updated) {
      return res.status(404).json({ error: "Admin user not found" });
    }
    res.sendStatus(204);
  } catch (err) {
    console.error("Error updating admin password:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/admin/users/:id/admin", requireAdmin, (req, res) => {
  const { isAdmin } = req.body || {};
  if (typeof isAdmin !== "boolean") {
    return res.status(400).json({ error: "isAdmin must be boolean" });
  }

  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  const user = getUserById(userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  if (user.is_superadmin && !isAdmin) {
    return res.status(403).json({ error: "Superadmin cannot be demoted" });
  }
  if (user.is_guest_profile) {
    return res.status(403).json({ error: "Guest profile cannot be an admin account" });
  }

  try {
    const updated = setUserAdminRole(userId, isAdmin);
    if (!updated) {
      return res.status(404).json({ error: "User not found" });
    }
    res.sendStatus(204);
  } catch (err) {
    console.error("Error updating admin role:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

async function createAdminLoginLinkPayload(kind, id, req, includeQrCode = false) {
  const active = resolveTransportAnnouncedAddress();
  const connectUrl = resolveAdminConnectUrl(active.announcedAddress, req);
  let token = null;
  let loginUrl = "";

  if (kind === "feed") {
    token = createFeedLoginToken(id);
    loginUrl = buildLoginUrl(connectUrl, token);
  } else {
    const user = getUserById(id);
    if (!user) throw new Error("User not found");

    if (user.is_guest_profile) {
      const guestSettings = resolveGuestLoginSettings(loadRuntimeConfig() || {}, { createProfile: false });
      if (!guestSettings.enabled || String(guestSettings.profileUserId) !== String(user.id)) {
        throw new Error("Guest login is disabled");
      }
      loginUrl = buildGuestLoginUrl(connectUrl);
    } else {
      token = createUserLoginToken(id);
      loginUrl = buildLoginUrl(connectUrl, token);
    }
  }
  let qrCodeDataUrl = null;

  if (includeQrCode && loginUrl) {
    qrCodeDataUrl = await QRCode.toDataURL(loginUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 640,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    });
  }

  return { token, loginUrl: loginUrl || null, qrCodeDataUrl };
}

app.post("/admin/users/:id/login-link", requireAdmin, async (req, res) => {
  try {
    const payload = await createAdminLoginLinkPayload(
      "user",
      req.params.id,
      req,
      req.query?.qr === "1"
    );
    res.setHeader("Cache-Control", "no-store");
    return res.json(payload);
  } catch (err) {
    const status = err.message === "User not found" ? 404 : 400;
    return res.status(status).json({ error: err.message || "Failed to create login link" });
  }
});

app.post("/admin/feeds/:id/login-link", requireAdmin, async (req, res) => {
  try {
    const payload = await createAdminLoginLinkPayload(
      "feed",
      req.params.id,
      req,
      req.query?.qr === "1"
    );
    res.setHeader("Cache-Control", "no-store");
    return res.json(payload);
  } catch (err) {
    const status = err.message === "Feed not found" ? 404 : 400;
    return res.status(status).json({ error: err.message || "Failed to create login link" });
  }
});

app.post("/users", requireAdmin, (req, res) => {
  const { name, password } = req.body;
  try {
    const id = createUser(name, password);
    addEntityToPrimaryProductionWhenSingle("user", id);
    scheduleAdminStatusBroadcast("user-created");
    res.json({ id });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.message.includes("UNIQUE")) {
      res.status(409).json({ error: "Username already exists" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.post("/conferences", requireAdmin, (req, res) => {
  const { name } = req.body;
  try {
    const id = createConference(name);
    addEntityToPrimaryProductionWhenSingle("conference", id);
    res.json({ id });
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      res.status(409).json({ error: "Conference name already exists" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.post("/feeds", requireAdmin, (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) {
    return res.status(400).json({ error: "Name and password are required" });
  }
  try {
    const id = createFeed(name, password);
    addEntityToPrimaryProductionWhenSingle("feed", id);
    res.json({ id });
  } catch (err) {
    if (err.message.includes("exists")) {
      res.status(409).json({ error: err.message });
    } else {
      console.error("Error creating feed:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.post('/conferences/:conferenceId/users/:userId', requireAdmin, (req, res) => {
  try {
    const productionId = getSingleProductionMembershipScope();
    setProductionConferenceMembership(productionId, req.params.userId, req.params.conferenceId);
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    ns.entityNotifications.notifyConferenceMembersChanged(req.params.conferenceId, req.params.userId);
    broadcastRuntimeUserStates("conference-membership-added");
    res.sendStatus(204);
  } catch (err) {
    res.status(err?.statusCode || 400).json({ error: err.message || "Failed to add conference member" });
  }
});


app.post('/users/:id/targets', requireAdmin, (req, res) => {
  const { targetType, targetId } = req.body;
  try {
    const productionId = getSingleProductionMembershipScope();
    addProductionTarget(productionId, req.params.id, targetType, targetId);
    ns.entityNotifications.notifyTargetChange(req.params.id);
    if (targetType === 'conference') {
      ns.entityNotifications.notifyConferenceMembersChanged(targetId, req.params.id);
      broadcastRuntimeUserStates("conference-membership-added");
    }
    res.sendStatus(204);
  } catch (err) {
    console.error('Error in add-target:', err);
    res.status(err?.statusCode || 400).json({ error: err.message || 'Failed to add target' });
  }
});

app.put('/users/:id/targets/order', requireAdmin, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) {
    return res.status(400).json({ error: 'items array required' });
  }

  const normalized = items.map(item => ({
    targetType: item?.targetType,
    targetId: Number(item?.targetId),
  }));

  const validTypes = ['user', 'conference', 'feed'];
  if (normalized.some(item => !validTypes.includes(item.targetType))) {
    return res.status(400).json({ error: 'Invalid target type' });
  }

  if (normalized.some(item => Number.isNaN(item.targetId))) {
    return res.status(400).json({ error: 'Invalid target id' });
  }

  try {
    const productionId = getSingleProductionMembershipScope();
    updateProductionTargetOrder(productionId, req.params.id, normalized);
    ns.entityNotifications.notifyTargetChange(req.params.id);
    res.sendStatus(204);
  } catch (err) {
    console.error('Failed to update target order:', err);
    res.status(err?.statusCode || 400).json({ error: err.message || 'Failed to reorder targets' });
  }
});