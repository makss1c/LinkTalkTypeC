/**
 * LinkTalk server — сессии админа и браузера, поток статуса админки
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const crypto = require("crypto");
const { createBrowserSessionStore } = require("../browserSessions");
const { isRunningInContainer } = require("../runtimeEnvironment");
const { getProductionById, isUserProductionAdmin, saveBrowserSession, getBrowserSessionByToken, deleteBrowserSession, purgeExpiredBrowserSessions } = require("../dbHandler");
const ns = require("../ns");

const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const BROWSER_SESSION_COOKIE = "linktalk_session";
// Cookie прежних установок: сессии, выданные до переименования, продолжают работать.
const LEGACY_BROWSER_SESSION_COOKIE = "talktome_session";
const BROWSER_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const adminSessions = new Map();
const browserSessions = createBrowserSessionStore({
  ttlMs: BROWSER_SESSION_TTL_MS,
  persistence: {
    read: getBrowserSessionByToken,
    write: saveBrowserSession,
    remove: deleteBrowserSession,
    purgeExpired: purgeExpiredBrowserSessions,
  },
});
const adminStatusStreams = new Set();
ns.sessions.adminStatusBroadcastTimer = null;
ns.sessions.pendingAdminStatusReason = "status-changed";
ns.sessions.pendingAdminStatusRefresh = { users: false, conferences: false, feeds: false };
ns.sessions.containerRestartScheduled = false;

function parseCookieHeader(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed client-controlled cookie values.
    }
  });
  return cookies;
}

function getAdminSession(req) {
  const cookies = parseCookieHeader(req.headers.cookie || "");
  const token = cookies.admin_session;
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return { token, session };
}

function getBrowserSessionFromCookieHeader(cookieHeader) {
  const cookies = parseCookieHeader(cookieHeader || "");
  return browserSessions.get(cookies[BROWSER_SESSION_COOKIE] || cookies[LEGACY_BROWSER_SESSION_COOKIE]);
}

function getBrowserSession(req) {
  return getBrowserSessionFromCookieHeader(req?.headers?.cookie || "");
}

function setBrowserSessionCookie(res, token) {
  res.cookie(BROWSER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    maxAge: BROWSER_SESSION_TTL_MS,
  });
}

function clearBrowserSessionCookies(res) {
  for (const name of [BROWSER_SESSION_COOKIE, LEGACY_BROWSER_SESSION_COOKIE]) {
    res.clearCookie(name, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
  }
}

function clearBrowserSession(req, res) {
  const result = getBrowserSession(req);
  if (result?.token) browserSessions.revoke(result.token);
  clearBrowserSessionCookies(res);
}

function createUserBrowserSession(res, user, source = "password") {
  const { token } = browserSessions.create({
    kind: "user",
    userId: Number(user.id),
    name: user.name,
    source,
  });
  setBrowserSessionCookie(res, token);
}

function createFeedBrowserSession(res, feed, source = "password") {
  const { token } = browserSessions.create({
    kind: "feed",
    feedId: Number(feed.id),
    name: feed.name,
    source,
  });
  setBrowserSessionCookie(res, token);
}

function createAdminSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, {
    userId: user.id,
    isGlobalAdmin: !!user.is_admin,
    isSuperAdmin: !!user.is_superadmin,
    createdAt: Date.now(),
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
  });
  return token;
}

function requireAdminSession(req, res, next) {
  const result = getAdminSession(req);
  if (!result) {
    return res.status(401).json({ error: "Admin login required" });
  }
  req.adminSession = result.session;
  req.adminToken = result.token;
  next();
}

function requireAdmin(req, res, next) {
  requireAdminSession(req, res, () => {
    if (!req.adminSession?.isGlobalAdmin) {
      return res.status(403).json({ error: "Global admin access required" });
    }
    next();
  });
}

function requireProductionManager(req, res, next) {
  requireAdminSession(req, res, () => {
    const productionId = Number(req.params.productionId || req.params.id);
    if (!Number.isFinite(productionId) || !getProductionById(productionId)) {
      return res.status(404).json({ error: "Production not found" });
    }
    if (
      !req.adminSession?.isGlobalAdmin
      && !isUserProductionAdmin(req.adminSession?.userId, productionId)
    ) {
      return res.status(403).json({ error: "Production admin access required" });
    }
    req.productionId = productionId;
    next();
  });
}

function requireSuperAdmin(req, res, next) {
  if (!req.adminSession?.isSuperAdmin) {
    return res.status(403).json({ error: "Superadmin required" });
  }
  next();
}

function isServerRestartSupported() {
  return isRunningInContainer() || process.env.LINKTALK_MANAGED_SERVER === "1";
}

function restartServerProcess() {
  if (ns.sessions.containerRestartScheduled) return;
  ns.sessions.containerRestartScheduled = true;

  // Give the response a moment to reach the browser before ending the current
  // process. Containers are restarted by their runtime. Native tray installs
  // use a dedicated exit code so their supervisor retains ownership of the
  // replacement process instead of the server spawning a detached child.
  setTimeout(() => {
    console.log("[ADMIN] Server restart requested.");
    const exitCode = !isRunningInContainer() && process.env.LINKTALK_MANAGED_SERVER === "1"
      ? 75
      : 0;
    ns.webServer.server.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 1_000).unref();
  }, 150).unref();
}

function writeAdminStatusEvent(stream, event, payload) {
  try {
    stream.res.write(`event: ${event}\n`);
    stream.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    adminStatusStreams.delete(stream);
    clearInterval(stream.heartbeat);
    return false;
  }
}

function scheduleAdminStatusBroadcast(reason = "status-changed") {
  if (adminStatusStreams.size === 0) return;
  ns.sessions.pendingAdminStatusReason = reason;
  if (reason === "bridge-endpoint-updated") {
    ns.sessions.pendingAdminStatusRefresh.users = true;
  } else if (reason === "bridge-feed-endpoint-updated") {
    ns.sessions.pendingAdminStatusRefresh.feeds = true;
  } else if (
    reason === "conference-membership-added"
    || reason === "conference-membership-removed"
  ) {
    ns.sessions.pendingAdminStatusRefresh.users = true;
    ns.sessions.pendingAdminStatusRefresh.conferences = true;
  }
  if (ns.sessions.adminStatusBroadcastTimer !== null) return;
  ns.sessions.adminStatusBroadcastTimer = setTimeout(() => {
    ns.sessions.adminStatusBroadcastTimer = null;
    const refresh = ns.sessions.pendingAdminStatusRefresh;
    ns.sessions.pendingAdminStatusRefresh = { users: false, conferences: false, feeds: false };
    const payload = {
      reason: ns.sessions.pendingAdminStatusReason,
      refresh,
      snapshot: ns.adminStatus.buildAdminStatusSnapshot(),
    };
    for (const stream of [...adminStatusStreams]) {
      writeAdminStatusEvent(stream, "status", payload);
    }
  }, 75);
}

function closeAdminStatusStreamsForToken(token, event = "auth-expired") {
  if (!token) return;
  for (const stream of [...adminStatusStreams]) {
    if (stream.token !== token) continue;
    writeAdminStatusEvent(stream, event, { reason: event });
    adminStatusStreams.delete(stream);
    clearInterval(stream.heartbeat);
    try {
      stream.res.end();
    } catch {}
  }
}
Object.assign(ns.sessions, {
  ADMIN_SESSION_TTL_MS,
  BROWSER_SESSION_COOKIE,
  clearBrowserSessionCookies,
  adminSessions,
  adminStatusStreams,
  browserSessions,
  clearBrowserSession,
  closeAdminStatusStreamsForToken,
  createAdminSession,
  createFeedBrowserSession,
  createUserBrowserSession,
  getAdminSession,
  getBrowserSession,
  getBrowserSessionFromCookieHeader,
  isServerRestartSupported,
  requireAdmin,
  requireAdminSession,
  requireProductionManager,
  requireSuperAdmin,
  restartServerProcess,
  scheduleAdminStatusBroadcast,
  writeAdminStatusEvent,
});
