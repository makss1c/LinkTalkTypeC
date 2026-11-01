/**
 * LinkTalk server — порты, mDNS-имя, тэлли
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { resolveWebAccess } = require("../webAccess");
const { createTallyStateStore } = require("../tallyState");
const { getPrimaryProduction } = require("../dbHandler");
const ns = require("../ns");
const { loadRuntimeConfig, normalizeHostname, parseOptionalPort, resolveActiveRtcPortRange } = ns.config;
const { isOperatorPeer } = ns.talkTargets;

// Backend web port (defaults to 443; HTTP in reverse-proxy mode)
const WEB_ACCESS = resolveWebAccess(loadRuntimeConfig() || {});
const HTTPS_PORT = WEB_ACCESS.httpsPort;
const WEB_PROTOCOL = WEB_ACCESS.tlsMode === "proxy" ? "http" : "https";
const mdnsHostname = (() => {
  const raw =
    process.env.MDNS_HOST ||
    process.env.MDNS_NAME ||
    process.env.INTERCOM_HOSTNAME;
  if (raw !== undefined) {
    const trimmed = String(raw).trim().toLowerCase();
    if (
      !trimmed ||
      ["off", "false", "no", "none", "disable", "disabled"].includes(trimmed)
    ) {
      return null;
    }
    return normalizeHostname(raw);
  }
  return normalizeHostname("intercom.local");
})();

ns.listenConfig.mdnsSocket = null;

const HTTP_PORT = (() => {
  if (WEB_ACCESS.tlsMode === "proxy") return null;
  const explicitPort = parseOptionalPort(process.env.HTTP_PORT);
  if (explicitPort !== null) {
    return explicitPort;
  }
  if (mdnsHostname) {
    return 80;
  }
  return null;
})();
const httpPortSource = process.env.HTTP_PORT ? "explicit" : (HTTP_PORT !== null ? "auto" : "disabled");
const RTC_PORT_RANGE = resolveActiveRtcPortRange(loadRuntimeConfig() || {});

// Tally is transient and scoped to the active production.
const tallyState = createTallyStateStore();

function getDefaultTallyProductionId() {
  return getPrimaryProduction()?.id ?? null;
}

function getTallyState(productionId = null) {
  return tallyState.get(productionId ?? getDefaultTallyProductionId());
}

function buildPeerTallyState(peer) {
  const productionId = peer?.productionId ?? getDefaultTallyProductionId();
  const state = getTallyState(productionId);
  return {
    productionId,
    pgm: Boolean(peer?.name && peer.name === state.pgmUser),
    prv: Boolean(peer?.name && peer.name === state.prvUser),
  };
}

function emitPeerTallyState(peer) {
  if (peer?.socket && isOperatorPeer(peer)) {
    peer.socket.emit("cut-camera", buildPeerTallyState(peer));
  }
}

function emitProductionTallyState(productionId) {
  for (const peer of ns.bridgeControl.peers.values()) {
    if (!isOperatorPeer(peer)) continue;
    if (String(peer.productionId ?? "") !== String(productionId ?? "")) continue;
    emitPeerTallyState(peer);
  }
}

function emitCompanionTallyEvent(productionId, payload) {
  if (!ns.companionAuth.companionNamespace) return;
  for (const socket of ns.companionAuth.companionNamespace.sockets.values()) {
    if (String(socket.data?.productionId ?? "") !== String(productionId ?? "")) continue;
    socket.emit("cut-camera", payload);
  }
}
Object.assign(ns.listenConfig, {
  HTTPS_PORT,
  HTTP_PORT,
  RTC_PORT_RANGE,
  WEB_ACCESS,
  WEB_PROTOCOL,
  emitCompanionTallyEvent,
  emitPeerTallyState,
  emitProductionTallyState,
  getDefaultTallyProductionId,
  getTallyState,
  httpPortSource,
  mdnsHostname,
  tallyState,
});
