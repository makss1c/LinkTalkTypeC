/**
 * LinkTalk server — рабочая конфигурация, продакшены, настройки RTC/mDNS/медиасети
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { listMediaNetworkInterfaces, normalizeSocketAddress, resolveTransportMediaRoute, normalizeMediaInterfaceNames } = require("../mediaNetwork");
const { resolveActiveProductionSelection } = require("../productionSelection");
const { getOrCreateGuestProfile, getUserById, getProductionById, getPrimaryProduction, getProductionsForUser, isUserInProduction, setProductionUser, setProductionConference, setProductionFeed, getProductionConferencesForUser, getFeedIdsForUser, getProductionFeedIdsForUser } = require("../dbHandler");
const ns = require("../ns");
const { DEFAULT_RTC_PORT_COUNT, DEFAULT_RTC_PORT_START, copyDirRecursive, dataConfigPath, execPublicDir, legacyConfigPath, legacyPkgConfigPath, snapshotPublicDir } = ns.base;

function normalizeHostname(value) {
  if (!value) return null;
  const trimmed = String(value).trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed) return null;
  return trimmed.endsWith(".local") ? trimmed : `${trimmed}.local`;
}

function parseOptionalPort(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed || trimmed === "false" || trimmed === "off" || trimmed === "no") {
    return null;
  }

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.warn(`[HTTP] Ignoring invalid HTTP_PORT value: ${value}`);
    return null;
  }

  return port;
}

function parseRequiredPort(value, fallback = null) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fallback;
  }
  return port;
}

ns.config.publicDir = snapshotPublicDir;
if (process.pkg) {
  try {
    if (copyDirRecursive(snapshotPublicDir, execPublicDir)) {
      ns.config.publicDir = execPublicDir;
    } else {
      console.warn(`[PUBLIC] Snapshot directory not found: ${snapshotPublicDir}`);
    }
  } catch (err) {
    console.warn(`[PUBLIC] Failed to materialize assets: ${err.message}`);
  }
}

if (!fs.existsSync(ns.config.publicDir)) {
  console.warn(`[PUBLIC] Not found: ${ns.config.publicDir}`);
} else if (!fs.existsSync(path.join(ns.config.publicDir, "index.html"))) {
  console.warn(`[PUBLIC] Missing index.html in ${ns.config.publicDir}`);
}

function getConfigPath() {
  const explicitConfigPath = String(process.env.LINKTALK_CONFIG_PATH || '').trim();
  if (explicitConfigPath) return path.resolve(explicitConfigPath);
  if (!process.pkg && fs.existsSync(legacyConfigPath)) {
    return legacyConfigPath;
  }

  if (process.pkg && fs.existsSync(legacyPkgConfigPath) && !fs.existsSync(dataConfigPath)) {
    return legacyPkgConfigPath;
  }

  return dataConfigPath;
}

function loadRuntimeConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return null;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // Retire legacy Apple PTT settings from future saves and configuration backups.
    delete config.applePtt;
    return config;
  } catch (error) {
    console.warn(`[CONFIG] Failed to read ${configPath}: ${error.message}`);
    return null;
  }
}

function saveRuntimeConfig(config) {
  const configPath = getConfigPath();

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function areMultipleProductionsEnabled(config = loadRuntimeConfig() || {}) {
  return config?.multipleProductions === true;
}

function normalizeActiveProductionId(value, userId) {
  const primaryProductionId = Number(getPrimaryProduction()?.id);
  const memberships = userId === null || userId === undefined
    ? []
    : getProductionsForUser(userId);
  const { productionId, hasRequestedProduction } = resolveActiveProductionSelection({
    requestedValue: value,
    multipleProductionsEnabled: areMultipleProductionsEnabled(),
    primaryProductionId,
    memberships,
  });
  if (!getProductionById(productionId)) {
    throw new Error("Production not found");
  }
  if (userId !== null && userId !== undefined && !isUserInProduction(userId, productionId)) {
    throw new Error(hasRequestedProduction
      ? "User is not a member of this production"
      : "This user is not assigned to the active production");
  }
  return productionId;
}

function getEffectiveConferencesForUser(userId, productionId = null) {
  const effectiveProductionId = productionId ?? getPrimaryProduction()?.id ?? null;
  return effectiveProductionId === null
    ? []
    : getProductionConferencesForUser(userId, effectiveProductionId);
}

function getSingleProductionMembershipScope() {
  if (areMultipleProductionsEnabled()) {
    const error = new Error("Conference membership is production-specific; manage it in the selected Matrix production");
    error.statusCode = 409;
    throw error;
  }
  const productionId = Number(getPrimaryProduction()?.id);
  if (!Number.isFinite(productionId)) {
    const error = new Error("Primary production not found");
    error.statusCode = 404;
    throw error;
  }
  return productionId;
}

function getEffectiveConferencesForPeer(peer) {
  if (!peer || !ns.talkTargets.isOperatorPeer(peer)) return [];
  const userId = peer.kind === "guest" ? peer.guestProfileUserId : peer.userId;
  if (userId === null || userId === undefined) return [];
  if (peer.isBridgePeer) {
    const conferences = new Map();
    for (const production of getProductionsForUser(userId)) {
      for (const conference of getProductionConferencesForUser(userId, production.id)) {
        const existing = conferences.get(Number(conference.id));
        conferences.set(Number(conference.id), {
          ...conference,
          canTalk: Boolean(existing?.canTalk || conference.canTalk),
        });
      }
    }
    return [...conferences.values()];
  }
  return getEffectiveConferencesForUser(userId, peer.productionId ?? null);
}

function getEffectiveFeedIdsForPeer(peer) {
  if (!peer || !ns.talkTargets.isOperatorPeer(peer)) return [];
  const userId = peer.kind === "guest" ? peer.guestProfileUserId : peer.userId;
  if (userId === null || userId === undefined) return [];
  return peer.productionId === null || peer.productionId === undefined
    ? getFeedIdsForUser(userId)
    : getProductionFeedIdsForUser(userId, peer.productionId);
}

function getEnabledProductionsForUser(userId) {
  return areMultipleProductionsEnabled() ? getProductionsForUser(userId) : [];
}

function addEntityToPrimaryProductionWhenSingle(type, entityId) {
  if (areMultipleProductionsEnabled()) return;
  const productionId = getPrimaryProduction()?.id;
  if (!productionId) return;
  if (type === "user") setProductionUser(productionId, entityId);
  else if (type === "conference") setProductionConference(productionId, entityId);
  else if (type === "feed") setProductionFeed(productionId, entityId);
}

function getDefaultRtcPortRange() {
  return {
    start: DEFAULT_RTC_PORT_START,
    count: DEFAULT_RTC_PORT_COUNT,
    end: DEFAULT_RTC_PORT_START + DEFAULT_RTC_PORT_COUNT - 1,
  };
}

function hasConfigValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function normalizeRtcPortRange(startValue, countValue, fallback = getDefaultRtcPortRange()) {
  const start = hasConfigValue(startValue) ? Number(startValue) : fallback.start;
  const count = hasConfigValue(countValue) ? Number(countValue) : fallback.count;

  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    return { error: "RTC port start must be a number between 1 and 65535." };
  }
  if (!Number.isInteger(count) || count < 1 || count > 65535) {
    return { error: "RTC port count must be a number between 1 and 65535." };
  }

  const end = start + count - 1;
  if (end > 65535) {
    return { error: "RTC port range must end at or below 65535." };
  }

  return { start, count, end };
}

function resolveSavedRtcPortRange(config) {
  const resolved = normalizeRtcPortRange(config?.rtcPortStart, config?.rtcPortCount);
  return resolved.error ? getDefaultRtcPortRange() : resolved;
}

function resolveActiveRtcPortRange(config) {
  const saved = resolveSavedRtcPortRange(config);
  const hasSavedRange =
    Object.prototype.hasOwnProperty.call(config || {}, "rtcPortStart") ||
    Object.prototype.hasOwnProperty.call(config || {}, "rtcPortCount");

  if (
    hasConfigValue(process.env.LINKTALK_RTC_PORT_START) ||
    hasConfigValue(process.env.LINKTALK_RTC_PORT_COUNT)
  ) {
    const resolved = normalizeRtcPortRange(
      process.env.LINKTALK_RTC_PORT_START,
      process.env.LINKTALK_RTC_PORT_COUNT
    );
    if (resolved.error) {
      console.warn(`[CONFIG] ${resolved.error} Falling back to RTC ports ${saved.start}-${saved.end}.`);
      return { ...saved, source: hasSavedRange ? "config" : "default" };
    }
    return { ...resolved, source: "env" };
  }

  return { ...saved, source: hasSavedRange ? "config" : "default" };
}

function normalizeGuestDisplayName(value) {
  const trimmed = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.slice(0, 40);
}

function resolveGuestLoginSettings(config, { createProfile = false, persist = false } = {}) {
  const currentConfig = config && typeof config === "object" ? config : {};
  const rawGuestConfig = currentConfig.guestLogin && typeof currentConfig.guestLogin === "object"
    ? currentConfig.guestLogin
    : {};
  let profile = null;
  const configuredProfileId = Number(rawGuestConfig.profileUserId);
  if (Number.isFinite(configuredProfileId)) {
    const candidate = getUserById(configuredProfileId);
    if (candidate?.is_guest_profile) {
      profile = candidate;
    }
  }

  if (!profile && createProfile) {
    profile = getOrCreateGuestProfile();
    addEntityToPrimaryProductionWhenSingle("user", profile.id);
  }

  const enabled = rawGuestConfig.enabled === true && !!profile;
  const resolved = {
    enabled,
    profileUserId: profile?.id ?? null,
    profileName: profile?.name || "Guest",
  };

  if (persist && profile && rawGuestConfig.profileUserId !== profile.id) {
    saveRuntimeConfig({
      ...currentConfig,
      guestLogin: {
        ...rawGuestConfig,
        enabled,
        profileUserId: profile.id,
      },
    });
  }

  return resolved;
}

function normalizeMdnsSetting(value) {
  if (value === undefined || value === null) {
    return "intercom.local";
  }

  const trimmed = String(value).trim();
  if (!trimmed) return "intercom.local";

  const lowered = trimmed.toLowerCase();
  if (["off", "false", "no", "none", "disable", "disabled"].includes(lowered)) {
    return "off";
  }

  const normalized = normalizeHostname(trimmed);
  if (!normalized) return "intercom.local";

  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeMediaNetworkMode(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "auto") return "auto";
  if (trimmed === "interface") return "interface";
  if (trimmed === "manual") return "manual";
  return null;
}

function normalizeMediaInterfaceName(value) {
  return normalizeMediaInterfaceNames(value).join(",");
}

function normalizeMediaAnnouncedAddress(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function resolveSavedMediaNetworkConfig(config) {
  const mode = normalizeMediaNetworkMode(config?.mediaNetworkMode)
    || (normalizeMediaInterfaceName(config?.mediaInterfaceName) ? "interface" : null)
    || (normalizeMediaAnnouncedAddress(config?.mediaAnnouncedAddress) ? "manual" : null)
    || "auto";

  return {
    mode,
    interfaceName: mode === "interface" ? normalizeMediaInterfaceName(config?.mediaInterfaceName) : "",
    announcedAddress: mode === "manual" ? normalizeMediaAnnouncedAddress(config?.mediaAnnouncedAddress) : "",
  };
}

function getAvailableMediaNetworkInterfaces() {
  return listMediaNetworkInterfaces(os.networkInterfaces());
}

function resolveTransportAnnouncedAddress() {
  const availableInterfaces = getAvailableMediaNetworkInterfaces();
  return resolveTransportMediaRoute({ env: process.env, availableInterfaces });
}

function getActiveRtcAddresses(mediaRoute) {
  const candidates = Array.isArray(mediaRoute?.candidateAddresses)
    ? mediaRoute.candidateAddresses
    : [];
  return [...new Set(candidates.map((address) => String(address || "").trim()).filter(Boolean))];
}

function buildMediaNetworkRequestWarning(mediaRoute, req) {
  if (mediaRoute?.mode === "manual") return null;
  const requestLocalAddress = normalizeSocketAddress(req?.socket?.localAddress);
  if (!requestLocalAddress || ["127.0.0.1", "0.0.0.0", "::"].includes(requestLocalAddress)) return null;
  const activeAddresses = getActiveRtcAddresses(mediaRoute);
  if (activeAddresses.includes(requestLocalAddress)) return null;
  return `This Admin page was reached through ${requestLocalAddress}, but RTC currently offers ${activeAddresses.join(", ") || "no usable address"}. Audio from this network may not connect.`;
}
Object.assign(ns.config, {
  addEntityToPrimaryProductionWhenSingle,
  areMultipleProductionsEnabled,
  buildMediaNetworkRequestWarning,
  getActiveRtcAddresses,
  getAvailableMediaNetworkInterfaces,
  getConfigPath,
  getEffectiveConferencesForPeer,
  getEffectiveFeedIdsForPeer,
  getEnabledProductionsForUser,
  getSingleProductionMembershipScope,
  loadRuntimeConfig,
  normalizeActiveProductionId,
  normalizeGuestDisplayName,
  normalizeHostname,
  normalizeMdnsSetting,
  normalizeMediaAnnouncedAddress,
  normalizeMediaInterfaceName,
  normalizeMediaNetworkMode,
  normalizeRtcPortRange,
  parseOptionalPort,
  parseRequiredPort,
  resolveActiveRtcPortRange,
  resolveGuestLoginSettings,
  resolveSavedMediaNetworkConfig,
  resolveSavedRtcPortRange,
  resolveTransportAnnouncedAddress,
  saveRuntimeConfig,
});
