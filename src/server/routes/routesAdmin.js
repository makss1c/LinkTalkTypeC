/**
 * LinkTalk server — вход администратора, продакшены, API-ключ
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { getAllUsers, getUserById, getAllConferences, getAllFeeds, getAllProductions, getProductionById, getProductionsForUser, createProduction, updateProductionName, deleteProduction, getProductionMembers, setProductionUser, removeProductionUser, getProductionConferences, getProductionFeeds, setProductionConference, removeProductionConference, setProductionFeed, removeProductionFeed, setProductionConferenceMembership, setProductionConferenceListenOnly, removeProductionConferenceMembership, getProductionTargets, addProductionTarget, removeProductionTarget, updateProductionTargetOrder, verifyUser } = require("../dbHandler");
const ns = require("../ns");
const { app } = ns.base;
const { ADMIN_SESSION_TTL_MS, adminSessions, closeAdminStatusStreamsForToken, createAdminSession, getAdminSession, requireAdmin, requireAdminSession, requireProductionManager } = ns.sessions;
const { regenerateCompanionApiKey } = ns.companionAuth;
const { tallyState } = ns.listenConfig;

app.post("/admin/login", (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) {
    return res.status(400).json({ error: "Name and password are required" });
  }

  try {
    const user = verifyUser(name, password);
    if (!user || user.is_guest_profile) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const productionAdminOf = getProductionsForUser(user.id).filter((production) => production.isAdmin);
    if (!user.is_admin && productionAdminOf.length === 0) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const token = createAdminSession(user);
    res.cookie("admin_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: ADMIN_SESSION_TTL_MS,
    });
    return res.json({
      id: user.id,
      name: user.name,
      isAdmin: !!user.is_admin,
      isGlobalAdmin: !!user.is_admin,
      isSuperadmin: !!user.is_superadmin,
      mustChangePassword: !!user.admin_must_change,
      productionAdminOf: productionAdminOf.map(({ id, name: productionName }) => ({ id, name: productionName })),
    });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/admin/logout", requireAdminSession, (req, res) => {
  if (req.adminToken) {
    closeAdminStatusStreamsForToken(req.adminToken, "logged-out");
    adminSessions.delete(req.adminToken);
  }
  res.clearCookie("admin_session", { httpOnly: true, sameSite: "lax", secure: true });
  res.sendStatus(204);
});

app.get(["/admin", "/admin/"], (req, res) => {
  res.redirect("/admin.html");
});

app.get(["/debug", "/debug/"], (req, res) => {
  res.redirect("/debug.html");
});

app.get("/admin/me", (req, res) => {
  const result = getAdminSession(req);
  if (!result) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const user = getUserById(result.session.userId);
  const productionAdminOf = user
    ? getProductionsForUser(user.id).filter((production) => production.isAdmin)
    : [];
  if (!user || (!user.is_admin && productionAdminOf.length === 0)) {
    adminSessions.delete(result.token);
    res.clearCookie("admin_session", { httpOnly: true, sameSite: "lax", secure: true });
    return res.status(401).json({ error: "Not authenticated" });
  }

  return res.json({
    id: user.id,
    name: user.name,
    isAdmin: !!user.is_admin,
    isGlobalAdmin: !!user.is_admin,
    isSuperadmin: !!user.is_superadmin,
    mustChangePassword: !!user.admin_must_change,
    productionAdminOf: productionAdminOf.map(({ id, name: productionName }) => ({ id, name: productionName })),
  });
});

app.get("/admin/productions", requireAdminSession, (req, res) => {
  try {
    const productions = req.adminSession.isGlobalAdmin
      ? getAllProductions()
      : getProductionsForUser(req.adminSession.userId)
        .filter((production) => production.isAdmin)
        .map(({ isAdmin, ...production }) => production);
    res.json(productions);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load productions" });
  }
});

app.post("/admin/productions", requireAdmin, (req, res) => {
  try {
    const id = createProduction(req.body?.name);
    res.status(201).json(getProductionById(id));
  } catch (err) {
    const conflict = String(err?.message || "").includes("already exists");
    res.status(conflict ? 409 : 400).json({ error: err.message || "Failed to create production" });
  }
});

app.get("/admin/productions/:productionId", requireProductionManager, (req, res) => {
  try {
    const members = getProductionMembers(req.productionId);
    const conferences = getProductionConferences(req.productionId);
    const feeds = getProductionFeeds(req.productionId);
    const targets = {};
    members.forEach((member) => {
      targets[String(member.id)] = getProductionTargets(member.id, req.productionId);
    });
    res.json({
      production: getProductionById(req.productionId),
      members,
      conferences,
      feeds,
      targets,
      catalog: {
        users: getAllUsers()
          .filter((user) => !user.is_superadmin)
          .map((user) => ({ id: user.id, name: user.name, is_guest_profile: user.is_guest_profile })),
        conferences: getAllConferences(),
        feeds: getAllFeeds().map((feed) => ({ id: feed.id, name: feed.name })),
      },
      permissions: {
        globalAdmin: Boolean(req.adminSession.isGlobalAdmin),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load production" });
  }
});

app.put("/admin/productions/:productionId/conferences/:conferenceId", requireProductionManager, (req, res) => {
  try {
    setProductionConference(req.productionId, req.params.conferenceId);
    res.sendStatus(204);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to add conference to production" });
  }
});

app.delete("/admin/productions/:productionId/conferences/:conferenceId", requireProductionManager, (req, res) => {
  try {
    removeProductionConference(req.productionId, req.params.conferenceId);
    ns.entityNotifications.notifyConferenceMembersChanged(req.params.conferenceId);
    res.sendStatus(204);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to remove conference from production" });
  }
});

app.put("/admin/productions/:productionId/feeds/:feedId", requireProductionManager, (req, res) => {
  try {
    setProductionFeed(req.productionId, req.params.feedId);
    res.sendStatus(204);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to add feed to production" });
  }
});

app.delete("/admin/productions/:productionId/feeds/:feedId", requireProductionManager, (req, res) => {
  try {
    removeProductionFeed(req.productionId, req.params.feedId);
    ns.producerRouting.reconcileAllProducerRecipients();
    res.sendStatus(204);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to remove feed from production" });
  }
});

app.put("/admin/productions/:productionId/conferences/:conferenceId/users/:userId", requireProductionManager, (req, res) => {
  try {
    setProductionConferenceMembership(
      req.productionId,
      req.params.userId,
      req.params.conferenceId
    );
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    ns.entityNotifications.notifyConferenceMembersChanged(req.params.conferenceId);
    res.sendStatus(204);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to update conference membership" });
  }
});

app.delete("/admin/productions/:productionId/conferences/:conferenceId/users/:userId", requireProductionManager, (req, res) => {
  try {
    removeProductionConferenceMembership(
      req.productionId,
      req.params.userId,
      req.params.conferenceId
    );
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    ns.entityNotifications.notifyConferenceMembersChanged(req.params.conferenceId);
    res.sendStatus(204);
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to update conference membership" });
  }
});

app.put("/admin/productions/:productionId", requireAdmin, (req, res) => {
  try {
    if (!updateProductionName(req.params.productionId, req.body?.name)) {
      return res.status(404).json({ error: "Production not found" });
    }
    ns.entityNotifications.notifyAvailableProductionsChanged();
    res.json(getProductionById(req.params.productionId));
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to update production" });
  }
});

app.delete("/admin/productions/:productionId", requireAdmin, (req, res) => {
  try {
    if (!deleteProduction(req.params.productionId)) {
      return res.status(404).json({ error: "Production not found" });
    }
    tallyState.remove(req.params.productionId);
    ns.entityNotifications.resetPeersUsingProduction(req.params.productionId);
    ns.entityNotifications.notifyAvailableProductionsChanged();
    res.sendStatus(204);
  } catch (err) {
    const lastProduction = err.message === "The last production cannot be deleted";
    res.status(lastProduction ? 409 : 500).json({ error: err.message || "Failed to delete production" });
  }
});

app.put("/admin/productions/:productionId/users/:userId", requireProductionManager, (req, res) => {
  try {
    const requestedAdmin = Boolean(req.body?.isAdmin);
    if (requestedAdmin && !req.adminSession.isGlobalAdmin) {
      return res.status(403).json({ error: "Only global admins can assign production admins" });
    }
    const existing = getProductionMembers(req.productionId)
      .find((member) => Number(member.id) === Number(req.params.userId));
    const isAdmin = req.adminSession.isGlobalAdmin
      ? requestedAdmin
      : Boolean(existing?.isProductionAdmin);
    setProductionUser(req.productionId, req.params.userId, { isAdmin });
    ns.entityNotifications.notifyAvailableProductionsChanged(req.params.userId);
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to update production member" });
  }
});

app.delete("/admin/productions/:productionId/users/:userId", requireProductionManager, (req, res) => {
  try {
    const existing = getProductionMembers(req.productionId)
      .find((member) => Number(member.id) === Number(req.params.userId));
    if (!req.adminSession.isGlobalAdmin && existing?.isProductionAdmin) {
      return res.status(403).json({ error: "Only global admins can remove production admins" });
    }
    removeProductionUser(req.productionId, req.params.userId);
    ns.entityNotifications.resetPeersUsingProduction(req.productionId, req.params.userId);
    ns.entityNotifications.notifyAvailableProductionsChanged(req.params.userId);
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to remove production member" });
  }
});

app.post("/admin/productions/:productionId/users/:userId/targets", requireProductionManager, (req, res) => {
  try {
    addProductionTarget(
      req.productionId,
      req.params.userId,
      req.body?.targetType,
      req.body?.targetId
    );
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    if (req.body?.targetType === "conference") {
      ns.entityNotifications.notifyConferenceMembersChanged(req.body?.targetId);
    }
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to add production target" });
  }
});

app.put("/admin/productions/:productionId/users/:userId/targets/conference/:targetId", requireProductionManager, (req, res) => {
  try {
    if (req.body?.mode !== "listen-only") {
      return res.status(400).json({ error: "Unsupported conference target mode" });
    }
    setProductionConferenceListenOnly(
      req.productionId,
      req.params.userId,
      req.params.targetId
    );
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    ns.entityNotifications.notifyConferenceMembersChanged(req.params.targetId);
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to update conference target" });
  }
});

app.delete("/admin/productions/:productionId/users/:userId/targets/:type/:targetId", requireProductionManager, (req, res) => {
  try {
    removeProductionTarget(
      req.productionId,
      req.params.userId,
      req.params.type,
      req.params.targetId
    );
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    if (req.params.type === "conference") {
      ns.entityNotifications.notifyConferenceMembersChanged(req.params.targetId);
    }
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to remove production target" });
  }
});

app.put("/admin/productions/:productionId/users/:userId/targets/order", requireProductionManager, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: "items array required" });
  try {
    updateProductionTargetOrder(req.productionId, req.params.userId, items);
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    res.sendStatus(204);
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed to reorder production targets" });
  }
});

app.get("/admin/api-key", requireAdmin, (req, res) => {
  res.json({ apiKey: ns.companionAuth.companionApiKey });
});

app.post("/admin/api-key/regenerate", requireAdmin, (req, res) => {
  try {
    const apiKey = regenerateCompanionApiKey();
    res.json({ apiKey });
  } catch (err) {
    console.error(`[COMPANION] Failed to regenerate API key: ${err.message}`);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to regenerate API key",
    });
  }
});