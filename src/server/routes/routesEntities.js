/**
 * LinkTalk server — изменение и удаление пользователей, фидов, конференций
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { updateUserName, updateConferenceName, updateUserPassword, updateFeedName, updateFeedPassword, getUserById, getAllFeeds, removeProductionConferenceMembership, removeProductionTarget, deleteUser, deleteConference, deleteFeed, getUsersForFeed, updateFeedBridgeEndpoint, updateUserBridgeEndpoint } = require("../dbHandler");
const ns = require("../ns");
const { app } = ns.base;
const { getSingleProductionMembershipScope } = ns.config;
const { requireAdmin, scheduleAdminStatusBroadcast } = ns.sessions;
const { canCompanionControlUser, requireCompanionApiKey } = ns.companionAuth;
const { broadcastRuntimeUserStates, dispatchTalkCommandToUser, isCompanionAddressableUserId, normalizeTalkCommandInput } = ns.companionState;

app.post('/users/:id/talk', requireCompanionApiKey, (req, res) => {
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

  const dispatch = dispatchTalkCommandToUser(userId, normalized.value.payload);
  if (!dispatch.ok) {
    return res.status(dispatch.status || 500).json({ error: dispatch.error || "Dispatch failed" });
  }

  res.sendStatus(202);
});

// === PUT ===
app.put("/users/:id", requireAdmin, (req, res) => {
  const { name } = req.body;
  try {
    const success = updateUserName(req.params.id, name);
    if (!success) return res.status(404).json({ error: "User not found" });
    scheduleAdminStatusBroadcast("user-renamed");
    res.sendStatus(204);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.message.includes("UNIQUE")) {
      res.status(409).json({ error: "Username already exists" });
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.put('/users/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body;

  if (typeof password !== 'string' || password.trim().length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters long' });
  }

  try {
    const user = getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_guest_profile) {
      return res.status(403).json({ error: 'Guest profile does not use a password' });
    }

    const updated = updateUserPassword(req.params.id, password.trim());
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.sendStatus(204);
  } catch (err) {
    console.error('Error updating password:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/users/:id/bridge-endpoint', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  try {
    const user = getUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.is_guest_profile) {
      return res.status(403).json({ error: 'Guest profile cannot be a bridge endpoint' });
    }
    if (user.is_superadmin) {
      return res.status(403).json({ error: 'Superadmin cannot be a bridge endpoint' });
    }

    const updated = updateUserBridgeEndpoint(userId, req.body || {});
    if (!updated) return res.status(404).json({ error: 'User not found' });
    scheduleAdminStatusBroadcast("bridge-endpoint-updated");
    res.sendStatus(204);
  } catch (err) {
    const message = String(err?.message || 'Invalid bridge endpoint config');
    if (
      message.includes('channel') ||
      message.includes('required') ||
      message.toLowerCase().includes('production') ||
      message.includes('Invalid user id')
    ) {
      return res.status(400).json({ error: message });
    }
    console.error('Error updating bridge endpoint:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/feeds/:id/bridge-endpoint', requireAdmin, (req, res) => {
  const feedId = Number(req.params.id);
  if (!Number.isInteger(feedId) || feedId < 1) {
    return res.status(400).json({ error: 'Invalid feed id' });
  }

  try {
    const feed = getAllFeeds().find((entry) => Number(entry.id) === feedId);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    const updated = updateFeedBridgeEndpoint(feedId, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Feed not found' });
    scheduleAdminStatusBroadcast("bridge-feed-endpoint-updated");
    res.sendStatus(204);
  } catch (err) {
    const message = String(err?.message || 'Invalid bridge endpoint config');
    if (
      message.includes('channel') ||
      message.includes('required') ||
      message.toLowerCase().includes('production') ||
      message.includes('Invalid feed id')
    ) {
      return res.status(400).json({ error: message });
    }
    console.error('Error updating feed bridge endpoint:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rename conference
app.put('/conferences/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  try {
    const success = updateConferenceName(req.params.id, name);
    if (!success) return res.status(404).json({ error: 'Conference not found' });
    ns.entityNotifications.notifyConferenceMembersChanged(req.params.id);
    res.sendStatus(204);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      res.status(409).json({ error: 'Conference name already exists' });
    } else {
      console.error('Error renaming conference:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.put('/feeds/:id', requireAdmin, (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const listeners = getUsersForFeed(req.params.id) || [];
    const updated = updateFeedName(req.params.id, name.trim());
    if (!updated) return res.status(404).json({ error: 'Feed not found' });
    listeners.forEach(({ user_id }) => ns.entityNotifications.notifyTargetChange(user_id));
    res.sendStatus(204);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('UNIQUE')) {
      res.status(409).json({ error: 'Feed name already exists' });
    } else {
      console.error('Error renaming feed:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.put('/feeds/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.trim().length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters long' });
  }

  try {
    const updated = updateFeedPassword(req.params.id, password.trim());
    if (!updated) return res.status(404).json({ error: 'Feed not found' });
    res.sendStatus(204);
  } catch (err) {
    console.error('Error updating feed password:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// === DELETE (specific routes FIRST) ===
app.delete("/conferences/:conferenceId/users/:userId", requireAdmin, (req, res) => {
  try {
    const productionId = getSingleProductionMembershipScope();
    removeProductionConferenceMembership(productionId, req.params.userId, req.params.conferenceId);
    ns.entityNotifications.notifyTargetChange(req.params.userId);
    ns.entityNotifications.notifyConferenceMembersChanged(req.params.conferenceId, req.params.userId);
    broadcastRuntimeUserStates("conference-membership-removed");
    res.sendStatus(204);
  } catch (err) {
    console.error(err);
    res.status(err?.statusCode || 500).json({ error: err.message || "Internal server error" });
  }
});

// Delete user (generic)
app.delete("/users/:id", requireAdmin, (req, res) => {
  try {
    const user = getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    if (user.is_admin) {
      return res.status(403).json({ error: "Admin accounts cannot be deleted" });
    }
    if (user.is_guest_profile) {
      return res.status(403).json({ error: "Guest profile cannot be deleted" });
    }
    deleteUser(req.params.id);
    ns.entityNotifications.notifyConferenceMembersChanged(null);
    scheduleAdminStatusBroadcast("user-deleted");
    res.sendStatus(204);
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

app.delete("/feeds/:id", requireAdmin, (req, res) => {
  try {
    const listeners = getUsersForFeed(req.params.id) || [];
    deleteFeed(req.params.id);
    listeners.forEach(({ user_id }) => ns.entityNotifications.notifyTargetChange(user_id));
    res.sendStatus(204);
  } catch (err) {
    res.status(500).json({ error: "Failed to delete feed" });
  }
});

// Delete conference (generic)
app.delete("/conferences/:id", requireAdmin, (req, res) => {
  try {
    deleteConference(req.params.id);
    ns.entityNotifications.notifyConferenceMembersChanged(req.params.id);
    broadcastRuntimeUserStates("conference-deleted");
    res.sendStatus(204);
  } catch (err) {
    console.error('Error deleting conference:', err);
    res.status(500).json({ error: err?.message || "Failed to delete conference" });
  }
});

app.delete("/users/:id/targets/:type/:tid", requireAdmin, (req, res) => {
  try {
    const productionId = getSingleProductionMembershipScope();
    removeProductionTarget(productionId, req.params.id, req.params.type, req.params.tid);
    ns.entityNotifications.notifyTargetChange(req.params.id);
    if (req.params.type === 'conference') {
      ns.entityNotifications.notifyConferenceMembersChanged(req.params.tid, req.params.id);
      broadcastRuntimeUserStates("conference-membership-removed");
    }
    res.sendStatus(204);
  } catch (err) {
    res.status(err?.statusCode || 400).json({ error: err.message || 'Failed to remove target' });
  }
});