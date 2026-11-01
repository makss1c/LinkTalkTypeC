/**
 * LinkTalk server — запуск веб-сервера
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const { isRunningInContainer } = require("../runtimeEnvironment");
const ns = require("../ns");
const { getActiveRtcAddresses, resolveTransportAnnouncedAddress } = ns.config;
const { COMPANION_API_KEY_FILE, readCompanionApiKeyFromEnv } = ns.companionAuth;
const { HTTPS_PORT, WEB_ACCESS, WEB_PROTOCOL, mdnsHostname } = ns.listenConfig;
const { server, tlsReadyPromise } = ns.webServer;
const { getStartupHosts, startMdnsResponder } = ns.networkUtils;
const { mediaReadyPromise } = ns.mediaInit;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[${WEB_PROTOCOL.toUpperCase()}] Port ${HTTPS_PORT} is already in use.`);
    console.error("       Choose another port or stop the process using it.");
  } else if (err.code === "EACCES") {
    console.error(`[${WEB_PROTOCOL.toUpperCase()}] Permission denied on port ${HTTPS_PORT}.`);
    console.error("       Run with elevated privileges or choose a high port.");
  } else {
    console.error(`[${WEB_PROTOCOL.toUpperCase()}] Failed to start server on port ${HTTPS_PORT}: ${err.message}`);
  }
  process.exit(1);
});

function logWebServerReady() {
  const startupHosts = getStartupHosts();
  const configuredPublicIp = typeof process.env.PUBLIC_IP === "string"
    ? process.env.PUBLIC_IP.trim()
    : "";
  const runningInContainer = isRunningInContainer();
  const mediaRoute = resolveTransportAnnouncedAddress();
  console.log(`${WEB_PROTOCOL.toUpperCase()} Server running on port ${HTTPS_PORT}`);
  if (startupHosts.length > 0) {
    console.log("📍 Access via:");
    startupHosts.forEach((host) => {
      console.log(`   ${WEB_PROTOCOL}://${host}:${HTTPS_PORT}`);
    });
    console.log("🛠️ Administration via:");
    startupHosts.forEach((host) => {
      console.log(`   ${WEB_PROTOCOL}://${host}:${HTTPS_PORT}/admin`);
    });
  }
  if (runningInContainer) {
    console.log("");
    console.log("🐳 Docker note:");
    console.log("   Open the Docker host address in your browser, not the container IP.");
    if (configuredPublicIp) {
      console.log(`   From other devices: use ${WEB_PROTOCOL}://${configuredPublicIp}:${HTTPS_PORT}`);
    } else {
      console.log("   Use the LAN IP or DNS name of the host machine.");
      console.log("   Set PUBLIC_IP to print an explicit access URL here.");
    }
  }
  console.log("");
  if (mediaRoute.error) {
    console.warn(`🎛️ Media network: ${mediaRoute.error}`);
  } else if (mediaRoute.mode === "interface") {
    console.log(`🎛️ Media network: ${mediaRoute.interfaceName} → ${getActiveRtcAddresses(mediaRoute).join(", ")}`);
  } else if (mediaRoute.mode === "manual") {
    console.log(`🎛️ Media network: manual → ${mediaRoute.announcedAddress}`);
  } else if (mediaRoute.announcedAddress) {
    const routes = (mediaRoute.interfaces || [])
      .map((entry) => `${entry.name} → ${entry.address}`)
      .join(", ");
    console.log(`🎛️ Media network: automatic → ${routes || mediaRoute.announcedAddress}`);
  }
  console.log("");
  if (WEB_ACCESS.tlsMode === "internal") {
    console.log("⚠️  Browsers will show a certificate warning.");
    console.log('   Click "Advanced" → "Proceed to site" to continue.');
  } else {
    console.log("Use the public HTTPS reverse-proxy URL for browser microphone access.");
    if (WEB_ACCESS.publicUrl) console.log(`   ${WEB_ACCESS.publicUrl}`);
  }
  console.log("");
  if (mdnsHostname) {
    try {
      if (!ns.listenConfig.mdnsSocket) {
        ns.listenConfig.mdnsSocket = startMdnsResponder(mdnsHostname);
      }
      console.log(`📡 mDNS alias: ${WEB_PROTOCOL}://${mdnsHostname}:${HTTPS_PORT}`);
    } catch (err) {
      console.warn(`[mDNS] Failed to advertise ${mdnsHostname}: ${err.message}`);
    }
  } else {
    console.log("📡 mDNS alias disabled (no hostname configured)");
  }
  if (!process.env.PUBLIC_IP) {
    console.log("💡 For external access, set PUBLIC_IP environment variable:");
    console.log("   PUBLIC_IP=YOUR.PUBLIC.IP node server-https.js");
  }
  console.log("🔌 Companion API:");
  startupHosts.forEach((host) => {
    console.log(`   ${WEB_PROTOCOL}://${host}:${HTTPS_PORT}/api/v1/companion/state`);
  });
  console.log(`🔌 Companion Socket.IO namespace: /companion`);
  if (!readCompanionApiKeyFromEnv()) {
    console.log(`🔐 API key file: ${COMPANION_API_KEY_FILE}`);
  }
}

function startWebServer() {
  server.listen(HTTPS_PORT, logWebServerReady);
}

Promise.all([mediaReadyPromise, tlsReadyPromise]).then(startWebServer).catch((error) => {
  const message = error?.stack || error?.message || String(error);
  console.error(`[INIT] Server initialization failed: ${message}`);
  try {
    ns.bridgeControl.worker?.close();
  } catch {}
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});