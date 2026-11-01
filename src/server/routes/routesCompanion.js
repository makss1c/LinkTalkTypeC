/**
 * LinkTalk server — Companion HTTP API (состояние, пользователи)
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { getAllConferences, getAllFeeds, getAllProductions, getProductionMembers, getProductionConferences, getProductionFeeds } = require("../dbHandler");
const ns = require("../ns");
const { app } = ns.base;
const { areMultipleProductionsEnabled, getEnabledProductionsForUser } = ns.config;
const { buildCompanionAuthScope, hasCompanionGlobalAccess, requireCompanionApiKey, resolveCompanionProduction } = ns.companionAuth;
const { buildCompanionSnapshotForAuth, buildCompanionUserState, getCompanionAddressableUsers } = ns.companionState;

app.get("/api/v1/companion/config", requireCompanionApiKey, (req, res) => {
  const availableProductions = !areMultipleProductionsEnabled()
    ? []
    : hasCompanionGlobalAccess(req.companionAuth)
      ? getAllProductions().map(({ id, name }) => ({ id, name }))
      : getEnabledProductionsForUser(req.companionAuth.userId).map(({ id, name }) => ({ id, name }));
  res.json({
    version: 1,
    auth: {
      type: "api-key-or-session-token",
      header: "x-api-key",
      alternative: "Authorization: Bearer <api-key-or-session-token>",
      loginEndpoint: "/api/v1/companion/auth/login",
    },
    scope: buildCompanionAuthScope(req.companionAuth),
    productions: availableProductions,
    realtime: {
      transport: "socket.io",
      namespace: "/companion",
      events: ["snapshot", "user-state", "command-result", "cut-camera"],
    },
  });
});

app.get("/api/v1/companion/state", requireCompanionApiKey, (req, res) => {
  try {
    const productionId = resolveCompanionProduction(req.companionAuth, req.query?.productionId);
    res.json(buildCompanionSnapshotForAuth(req.companionAuth, productionId));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.get("/api/v1/companion/users", requireCompanionApiKey, (req, res) => {
  let productionId = null;
  try {
    productionId = resolveCompanionProduction(req.companionAuth, req.query?.productionId);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
  const memberIds = productionId === null
    ? null
    : new Set(getProductionMembers(productionId).map((member) => Number(member.id)));
  const allUsers = getCompanionAddressableUsers()
    .filter((user) => memberIds === null || memberIds.has(Number(user.id)))
    .map((user) => ({
      id: user.id,
      name: user.name,
      state: buildCompanionUserState(user.id, user.name, null, productionId),
    }));

  if (!hasCompanionGlobalAccess(req.companionAuth)) {
    const ownUserId = Number(req.companionAuth?.userId);
    const ownRows = allUsers.filter((row) => Number(row.id) === ownUserId);
    return res.json(ownRows);
  }

  res.json(allUsers);
});

app.get("/api/v1/companion/conferences", requireCompanionApiKey, (req, res) => {
  try {
    const productionId = resolveCompanionProduction(req.companionAuth, req.query?.productionId);
    res.json(productionId === null ? getAllConferences() : getProductionConferences(productionId));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.get("/api/v1/companion/feeds", requireCompanionApiKey, (req, res) => {
  try {
    const productionId = resolveCompanionProduction(req.companionAuth, req.query?.productionId);
    res.json(productionId === null ? getAllFeeds() : getProductionFeeds(productionId));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});