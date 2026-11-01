/**
 * LinkTalk server — вход пользователей (логин, SSO, токен, гость)
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const crypto = require("crypto");
const { resolveProxySsoIdentity } = require("../proxySso");
const { getUserByLoginToken, getFeedByLoginToken, getUserById, getFeedById, verifyUser, getUserByName, verifyFeed } = require("../dbHandler");
const ns = require("../ns");
const { SERVER_APP_VERSION } = ns.runtime;
const { PROXY_SSO_CONFIG, SERVER_STARTED_AT, app } = ns.base;
const { getEnabledProductionsForUser, loadRuntimeConfig, normalizeGuestDisplayName, resolveGuestLoginSettings } = ns.config;
const { clearBrowserSessionCookies, browserSessions, clearBrowserSession, createFeedBrowserSession, createUserBrowserSession, getBrowserSession } = ns.sessions;

function buildLoginIdentity(user, kind = "user") {
  const productions = kind === "user" || kind === "guest"
    ? getEnabledProductionsForUser(user.id).map(({ id, name }) => ({ id, name }))
    : [];
  const storedUser = kind === "user" ? getUserById(user.id) : null;
  return {
    id: user.id,
    name: user.name,
    kind,
    productions,
    configuredAsBridge: kind === "user" && Boolean(storedUser?.bridge_enabled),
  };
}

function buildBrowserSessionIdentity(result) {
  const browserSession = result?.session;
  if (!browserSession) return null;

  if (browserSession.kind === "user") {
    const user = getUserById(browserSession.userId);
    if (!user || user.is_guest_profile) return null;
    return buildLoginIdentity(user);
  }

  if (browserSession.kind === "feed") {
    const feed = getFeedById(browserSession.feedId);
    if (!feed) return null;
    return { id: feed.id, name: feed.name, kind: "feed" };
  }

  return null;
}

// === POST ===
app.get("/login/options", (req, res) => {
  try {
    const settings = resolveGuestLoginSettings(loadRuntimeConfig() || {}, { createProfile: false });
    res.json({
      appVersion: SERVER_APP_VERSION,
      guestLogin: {
        enabled: settings.enabled,
        label: settings.profileName || "Guest",
      },
      sso: {
        enabled: PROXY_SSO_CONFIG.enabled,
      },
    });
  } catch (err) {
    console.error("Login options error:", err);
    res.json({
      appVersion: SERVER_APP_VERSION,
      guestLogin: { enabled: false, label: "Guest" },
      sso: { enabled: PROXY_SSO_CONFIG.enabled },
    });
  }
});

app.get("/login/session", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const result = getBrowserSession(req);
  const identity = buildBrowserSessionIdentity(result);
  if (!identity) {
    if (result?.token) browserSessions.revoke(result.token);
    clearBrowserSessionCookies(res);
    return res.sendStatus(204);
  }
  return res.json(identity);
});

app.post("/login/sso", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const resolved = resolveProxySsoIdentity(req, PROXY_SSO_CONFIG);
  if (resolved.status !== "authenticated") {
    return res.sendStatus(204);
  }

  // Resolve a unique username without regard to casing. There is no implicit
  // account creation and privileged/Guest profiles cannot be entered through SSO.
  const user = getUserByName(resolved.identity);
  if (!user || user.is_guest_profile || user.is_superadmin) {
    clearBrowserSession(req, res);
    console.warn(`[SSO] No eligible LinkTalk user for identity ${JSON.stringify(resolved.identity)}`);
    return res.sendStatus(204);
  }

  const currentSession = getBrowserSession(req);
  if (currentSession?.token) browserSessions.revoke(currentSession.token);
  createUserBrowserSession(res, user, "trusted-header");
  console.log(`[SSO] Login successful for user: ${user.name}`);
  return res.json(buildLoginIdentity(user));
});

app.post("/login", (req, res) => {
  console.log("trying to login");
  const { name, password } = req.body;

  try {
    const user = verifyUser(name, password);
    if (user) {
      if (user.is_guest_profile) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      console.log("Login successful for user:", user.name);
      createUserBrowserSession(res, user);
      return res.json(buildLoginIdentity(user));
    }

    const feed = verifyFeed(name, password);
    if (feed) {
      console.log("Login successful for feed:", feed.name);
      createFeedBrowserSession(res, feed);
      return res.json({ id: feed.id, name: feed.name, kind: "feed" });
    }

    console.warn("Login failed for:", name);
    return res.status(401).json({ error: "Invalid credentials" });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/login/token", (req, res) => {
  try {
    const user = getUserByLoginToken(req.body?.token);
    if (user) {
      console.log("Login URL used for user:", user.name);
      res.setHeader("Cache-Control", "no-store");
      createUserBrowserSession(res, user, "login-token");
      return res.json(buildLoginIdentity(user));
    }

    const feed = getFeedByLoginToken(req.body?.token);
    if (!feed) return res.status(401).json({ error: "Invalid or expired login link" });
    console.log("Login URL used for feed:", feed.name);
    res.setHeader("Cache-Control", "no-store");
    createFeedBrowserSession(res, feed, "login-token");
    return res.json(buildLoginIdentity(feed, "feed"));
  } catch (err) {
    console.error("Login URL error:", err);
    return res.status(500).json({ error: "Login link failed" });
  }
});

app.post("/login/guest", (req, res) => {
  try {
    const settings = resolveGuestLoginSettings(loadRuntimeConfig() || {}, { createProfile: true, persist: true });
    if (!settings.enabled || !settings.profileUserId) {
      return res.status(403).json({ error: "Guest login is disabled" });
    }

    const requestedName = normalizeGuestDisplayName(req.body?.name);
    const shortId = crypto.randomBytes(2).toString("hex").toUpperCase();
    const name = requestedName || `${settings.profileName || "Guest"} ${shortId}`;
    return res.json({
      kind: "guest",
      guestId: crypto.randomUUID(),
      guestProfileUserId: settings.profileUserId,
      name,
      productions: getEnabledProductionsForUser(settings.profileUserId).map(({ id, name: productionName }) => ({
        id,
        name: productionName,
      })),
    });
  } catch (err) {
    console.error("Guest login error:", err);
    return res.status(500).json({ error: "Guest login failed" });
  }
});

app.get("/api/v1/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    appVersion: SERVER_APP_VERSION,
    serverStartedAt: new Date(SERVER_STARTED_AT).toISOString(),
  });
});