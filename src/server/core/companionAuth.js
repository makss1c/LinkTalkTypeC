/**
 * LinkTalk server — Companion: ключи, сессии, авторизация моста
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDataDir } = require("../dataPaths");
const { getProductionById, getPrimaryProduction, getProductionsForUser, isUserInProduction } = require("../dbHandler");
const ns = require("../ns");
const { bridgeRegistry, bridgeTokenStore } = ns.base;
const { areMultipleProductionsEnabled } = ns.config;
const { scheduleAdminStatusBroadcast } = ns.sessions;

const COMPANION_DEFAULT_WAIT_MS = 1500;
const COMPANION_MAX_WAIT_MS = 10000;
const COMPANION_PENDING_TTL_MS = 30000;
const COMPANION_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const COMPANION_DEFAULT_VOLUME_STEP = 0.1;
const COMPANION_STATUS_STALE_MS = 45000;
const COMPANION_API_KEY_FILE = path.join(getDataDir(), "companion_api_key");

const companionUserState = new Map();
const companionPendingCommands = new Map();
const companionSessions = new Map();
ns.companionAuth.companionNamespace = null;

function markCompanionSocketSeen(socket) {
  if (!socket) return;
  const now = Date.now();
  socket.data.lastSeenAt = now;
  socket.data.lastSeenAtIso = new Date(now).toISOString();
  if (socket.data.statusStaleTimer) {
    clearTimeout(socket.data.statusStaleTimer);
  }
  socket.data.statusStaleTimer = setTimeout(() => {
    scheduleAdminStatusBroadcast("companion-stale");
  }, COMPANION_STATUS_STALE_MS + 250);
}

function clearCompanionStatusTimer(socket) {
  if (!socket?.data?.statusStaleTimer) return;
  clearTimeout(socket.data.statusStaleTimer);
  socket.data.statusStaleTimer = null;
}

function isCompanionSocketOnline(socket, now = Date.now()) {
  if (!socket?.connected) return false;
  const lastSeenAt = Number(socket.data?.lastSeenAt || socket.data?.connectedAt || 0);
  return lastSeenAt > 0 && now - lastSeenAt <= COMPANION_STATUS_STALE_MS;
}

function readCompanionApiKeyFromEnv() {
  if (typeof process.env.COMPANION_API_KEY !== "string") {
    return null;
  }
  const value = process.env.COMPANION_API_KEY.trim();
  return value.length ? value : null;
}

function loadOrCreateCompanionApiKey() {
  const envKey = readCompanionApiKeyFromEnv();
  if (envKey) {
    console.log("[COMPANION] Using API key from COMPANION_API_KEY");
    return envKey;
  }

  try {
    if (fs.existsSync(COMPANION_API_KEY_FILE)) {
      const existing = fs.readFileSync(COMPANION_API_KEY_FILE, "utf8").trim();
      if (existing) {
        console.log(`[COMPANION] Using API key from ${COMPANION_API_KEY_FILE}`);
        return existing;
      }
    }
  } catch (err) {
    console.warn(`[COMPANION] Failed to read API key file: ${err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(COMPANION_API_KEY_FILE), { recursive: true });
    fs.writeFileSync(COMPANION_API_KEY_FILE, generated, { mode: 0o600 });
    console.log(`[COMPANION] Generated API key at ${COMPANION_API_KEY_FILE}`);
  } catch (err) {
    console.warn(`[COMPANION] Failed to persist API key: ${err.message}`);
  }
  return generated;
}

function persistCompanionApiKey(apiKey) {
  const directory = path.dirname(COMPANION_API_KEY_FILE);
  const tempFile = path.join(
    directory,
    `.companion_api_key.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );

  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(tempFile, apiKey, { mode: 0o600, flag: "wx" });
    fs.renameSync(tempFile, COMPANION_API_KEY_FILE);
    try {
      fs.chmodSync(COMPANION_API_KEY_FILE, 0o600);
    } catch {}
  } catch (err) {
    try {
      fs.unlinkSync(tempFile);
    } catch {}
    throw err;
  }
}

ns.companionAuth.companionApiKey = loadOrCreateCompanionApiKey();

function regenerateCompanionApiKey() {
  if (readCompanionApiKeyFromEnv()) {
    const err = new Error(
      "The API key is managed by COMPANION_API_KEY and cannot be regenerated in the Admin page.",
    );
    err.statusCode = 409;
    throw err;
  }

  const generated = crypto.randomBytes(32).toString("hex");
  persistCompanionApiKey(generated);
  ns.companionAuth.companionApiKey = generated;
  console.log(`[COMPANION] Regenerated API key at ${COMPANION_API_KEY_FILE}`);
  return generated;
}

function parseBearerToken(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function extractCompanionApiKeyFromRequest(req) {
  const bearer = parseBearerToken(req.get("authorization"));
  if (bearer) return bearer;

  const headerKey = req.get("x-api-key");
  if (headerKey) return String(headerKey).trim();

  if (typeof req.query?.apiKey === "string" && req.query.apiKey.trim()) {
    return req.query.apiKey.trim();
  }

  return null;
}

function extractCompanionApiKeyFromSocket(socket) {
  const authPayload = socket?.handshake?.auth || {};
  if (typeof authPayload === "object" && authPayload !== null) {
    if (typeof authPayload.apiKey === "string" && authPayload.apiKey.trim()) {
      return authPayload.apiKey.trim();
    }
    if (typeof authPayload.token === "string" && authPayload.token.trim()) {
      return authPayload.token.trim();
    }
  }

  const headers = socket?.handshake?.headers || {};
  const bearer = parseBearerToken(headers.authorization);
  if (bearer) return bearer;

  const headerKey = headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) {
    return headerKey.trim();
  }

  const queryPayload = socket?.handshake?.query || {};
  if (typeof queryPayload.apiKey === "string" && queryPayload.apiKey.trim()) {
    return queryPayload.apiKey.trim();
  }

  return null;
}

function isValidCompanionApiKey(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(ns.companionAuth.companionApiKey, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createCompanionSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  companionSessions.set(token, {
    userId: user.id,
    userName: user.name || null,
    isAdmin: !!user.is_admin,
    isSuperadmin: !!user.is_superadmin,
    createdAt: now,
    expiresAt: now + COMPANION_SESSION_TTL_MS,
  });
  return token;
}

function getCompanionSession(token) {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value) return null;
  const session = companionSessions.get(value);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    companionSessions.delete(value);
    return null;
  }
  return { token: value, session };
}

function resolveCompanionAuth(candidate) {
  if (isValidCompanionApiKey(candidate)) {
    return {
      type: "api-key",
      token: null,
      userId: null,
      userName: null,
      isAdmin: true,
      isSuperadmin: true,
    };
  }

  const sessionResult = getCompanionSession(candidate);
  if (!sessionResult) return null;
  return {
    type: "session",
    token: sessionResult.token,
    userId: sessionResult.session.userId,
    userName: sessionResult.session.userName,
    isAdmin: !!sessionResult.session.isAdmin,
    isSuperadmin: !!sessionResult.session.isSuperadmin,
  };
}

function hasCompanionGlobalAccess(auth) {
  return Boolean(auth && (auth.type === "api-key" || auth.isSuperadmin));
}

function generateBridgeToken() {
  return `ttm_bridge_${crypto.randomBytes(32).toString("hex")}`;
}

function hashBridgeToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function isValidBridgeTokenHash(candidate, expectedHash) {
  if (typeof candidate !== "string" || !candidate || typeof expectedHash !== "string" || !expectedHash) {
    return false;
  }
  const left = Buffer.from(hashBridgeToken(candidate), "hex");
  const right = Buffer.from(expectedHash, "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function resolveBridgeTokenAuth(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  for (const entry of bridgeRegistry.values()) {
    if (isValidBridgeTokenHash(candidate.trim(), entry.tokenHash)) {
      return {
        type: "bridge-token",
        bridgeId: entry.id,
        isAdmin: false,
        isSuperadmin: false,
      };
    }
  }
  for (const [bridgeId, entry] of bridgeTokenStore.entries()) {
    if (isValidBridgeTokenHash(candidate.trim(), entry.tokenHash)) {
      return {
        type: "bridge-token",
        bridgeId,
        isAdmin: false,
        isSuperadmin: false,
      };
    }
  }
  return null;
}

function resolveBridgeApiAuth(candidate) {
  const companionAuth = resolveCompanionAuth(candidate);
  if (companionAuth) {
    return {
      type: "companion",
      companionAuth,
      isAdmin: companionAuth.isAdmin,
      isSuperadmin: companionAuth.isSuperadmin,
    };
  }
  return resolveBridgeTokenAuth(candidate);
}

function hasBridgeGlobalAccess(auth) {
  return Boolean(auth?.type === "companion" && hasCompanionGlobalAccess(auth.companionAuth));
}

function canBridgeAuthAccessBridge(auth, bridgeId) {
  if (hasBridgeGlobalAccess(auth)) return true;
  if (auth?.type !== "bridge-token") return false;
  return ns.bridgeRegistry.normalizeBridgeId(auth.bridgeId) === ns.bridgeRegistry.normalizeBridgeId(bridgeId);
}

function canCompanionControlUser(auth, userId) {
  if (!auth || !Number.isFinite(Number(userId))) return false;
  if (hasCompanionGlobalAccess(auth)) return true;
  return Number(auth.userId) === Number(userId);
}

function buildCompanionAuthScope(auth) {
  if (!auth) {
    return { mode: "none", userId: null };
  }
  if (hasCompanionGlobalAccess(auth)) {
    return {
      mode: "all",
      userId: Number.isFinite(Number(auth.userId)) ? Number(auth.userId) : null,
      userName: auth.userName || null,
      isSuperadmin: !!auth.isSuperadmin,
    };
  }
  return {
    mode: "self",
    userId: Number(auth.userId),
    userName: auth.userName || null,
    isSuperadmin: false,
  };
}

function requireCompanionApiKey(req, res, next) {
  const candidate = extractCompanionApiKeyFromRequest(req);
  const auth = resolveCompanionAuth(candidate);
  if (!candidate || !auth) {
    return res.status(401).json({ error: "Companion authentication required" });
  }
  req.companionAuth = auth;
  next();
}

function resolveCompanionProduction(auth, value) {
  if (!areMultipleProductionsEnabled()) return getPrimaryProduction()?.id ?? null;
  if (value === null || value === undefined || value === "") {
    const primaryId = getPrimaryProduction()?.id ?? null;
    if (primaryId === null || hasCompanionGlobalAccess(auth) || isUserInProduction(auth?.userId, primaryId)) {
      return primaryId;
    }
    return getProductionsForUser(auth?.userId)[0]?.id ?? null;
  }
  const productionId = Number(value);
  if (!Number.isFinite(productionId) || !getProductionById(productionId)) {
    const error = new Error("Production not found");
    error.statusCode = 404;
    throw error;
  }
  if (!hasCompanionGlobalAccess(auth) && !isUserInProduction(auth?.userId, productionId)) {
    const error = new Error("User is not a member of this production");
    error.statusCode = 403;
    throw error;
  }
  return productionId;
}

function requireBridgeApiAuth(req, res, next) {
  const candidate = extractCompanionApiKeyFromRequest(req);
  const auth = resolveBridgeApiAuth(candidate);
  if (!candidate || !auth) {
    return res.status(401).json({ error: "Bridge authentication required" });
  }
  req.bridgeApiAuth = auth;
  req.companionAuth = auth.type === "companion" ? auth.companionAuth : null;
  next();
}
Object.assign(ns.companionAuth, {
  COMPANION_API_KEY_FILE,
  COMPANION_DEFAULT_VOLUME_STEP,
  COMPANION_DEFAULT_WAIT_MS,
  COMPANION_MAX_WAIT_MS,
  COMPANION_PENDING_TTL_MS,
  COMPANION_SESSION_TTL_MS,
  buildCompanionAuthScope,
  canBridgeAuthAccessBridge,
  canCompanionControlUser,
  clearCompanionStatusTimer,
  companionPendingCommands,
  companionUserState,
  createCompanionSession,
  extractCompanionApiKeyFromSocket,
  generateBridgeToken,
  hasCompanionGlobalAccess,
  hashBridgeToken,
  isCompanionSocketOnline,
  markCompanionSocketSeen,
  readCompanionApiKeyFromEnv,
  regenerateCompanionApiKey,
  requireBridgeApiAuth,
  requireCompanionApiKey,
  resolveCompanionAuth,
  resolveCompanionProduction,
});
