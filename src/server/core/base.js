/**
 * LinkTalk server — express-приложение, SSO, пути данных, хранилище токенов моста
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { projectRoot } = require("../projectPaths");
const { loadProxySsoConfig } = require("../proxySso");
const { getDataDir } = require("../dataPaths");
const ns = require("../ns");

const app = express();
app.use(express.json({ limit: "10mb" }));
const PROXY_SSO_CONFIG = loadProxySsoConfig(process.env);

if (PROXY_SSO_CONFIG.enabled) {
  console.log(
    `[SSO] Trusted-header login enabled with ${PROXY_SSO_CONFIG.header} from `
    + PROXY_SSO_CONFIG.trustedProxies.join(", ")
  );
}

const execDir = path.dirname(process.execPath);
const execPublicDir = path.join(execDir, "public");
const snapshotPublicDir = path.join(projectRoot, "public");
const dataDir = getDataDir();
const dataConfigPath = path.join(dataDir, "config.json");
const bridgeTokenPath = path.join(dataDir, "bridge-tokens.json");
const legacyConfigPath = path.join(projectRoot, "config.json");
const legacyPkgConfigPath = path.join(execDir, "config.json");
const DEFAULT_RTC_PORT_START = 40000;
const DEFAULT_RTC_PORT_COUNT = 10000;
const BRIDGE_REGISTRY_STALE_MS = 45_000;
const BRIDGE_CONTROL_SESSION_STALE_MS = 30_000;
const BRIDGE_RTP_HANDSHAKE_TIMEOUT_MS = 3_000;
const SERVER_STARTED_AT = Date.now();

const bridgeRegistry = new Map();
const bridgeControlSessions = new Map();

function loadBridgeTokenStore() {
  try {
    if (!fs.existsSync(bridgeTokenPath)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(bridgeTokenPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return new Map();
    const entries = Object.entries(parsed)
      .map(([id, value]) => {
        const normalizedId = ns.bridgeRegistry.normalizeBridgeId(id);
        const token = typeof value?.token === "string" ? value.token.trim() : "";
        const tokenHash = typeof value?.tokenHash === "string" ? value.tokenHash.trim() : "";
        if (!normalizedId || !token || !tokenHash) return null;
        return [normalizedId, {
          token,
          tokenHash,
          createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
        }];
      })
      .filter(Boolean);
    return new Map(entries);
  } catch (err) {
    console.warn(`[BRIDGE] Failed to load bridge token store: ${err.message}`);
    return new Map();
  }
}

function saveBridgeTokenStore() {
  try {
    fs.mkdirSync(path.dirname(bridgeTokenPath), { recursive: true });
    const payload = {};
    for (const [id, entry] of bridgeTokenStore.entries()) {
      payload[id] = {
        token: entry.token,
        tokenHash: entry.tokenHash,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    }
    fs.writeFileSync(bridgeTokenPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`[BRIDGE] Failed to persist bridge token store: ${err.message}`);
  }
}

const bridgeTokenStore = loadBridgeTokenStore();

function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    return false;
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      // Read through the bundle's virtual filesystem before writing a real file.
      fs.writeFileSync(destPath, fs.readFileSync(srcPath));
    }
  }
  return true;
}
Object.assign(ns.base, {
  BRIDGE_CONTROL_SESSION_STALE_MS,
  BRIDGE_REGISTRY_STALE_MS,
  BRIDGE_RTP_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_RTC_PORT_COUNT,
  DEFAULT_RTC_PORT_START,
  PROXY_SSO_CONFIG,
  SERVER_STARTED_AT,
  app,
  bridgeControlSessions,
  bridgeRegistry,
  bridgeTokenStore,
  copyDirRecursive,
  dataConfigPath,
  dataDir,
  execPublicDir,
  legacyConfigPath,
  legacyPkgConfigPath,
  saveBridgeTokenStore,
  snapshotPublicDir,
});
