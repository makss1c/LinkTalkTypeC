/**
 * LinkTalk server — запуск mediasoup и список пользователей
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const fs = require("fs");
const ns = require("../ns");
const { CLIENT_ICE_CONFIG, mediasoup } = ns.runtime;
const { RTC_PORT_RANGE } = ns.listenConfig;

function warnIfDockerAnnouncedIpLooksInternal(announcedIp) {
  if (process.env.PUBLIC_IP) return;
  if (!fs.existsSync("/.dockerenv")) return;
  if (typeof announcedIp !== "string") return;
  if (!/^172\.(1[6-9]|2\d|3[0-1])\./.test(announcedIp.trim())) return;

  console.warn(
    `[TRANSPORT][WARN] Auto-detected announced IP ${announcedIp} looks like a Docker-internal bridge address. ` +
    `WebRTC media will usually fail from outside the container. Set PUBLIC_IP to the host/LAN IP and publish RTC ports ${RTC_PORT_RANGE.start}-${RTC_PORT_RANGE.end}, ` +
    `or use --network host on Linux.`
  );
}

const mediaReadyPromise = (async () => {
  console.log("[INIT] Starting mediasoup worker");
  try {
    ns.bridgeControl.worker = await mediasoup.createWorker({
      rtcMinPort: RTC_PORT_RANGE.start,
      rtcMaxPort: RTC_PORT_RANGE.end,
      logLevel: "warn",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    // 0xC0000135 is Windows' STATUS_DLL_NOT_FOUND.  Keep this diagnostic
    // close to the actual cause; the mediasoup error otherwise only exposes
    // the opaque decimal exit code from its child process.
    if (process.platform === "win32" && /(?:3221225781|c0000135)/i.test(message)) {
      console.error(
        "[INIT] mediasoup worker could not load a required Windows runtime DLL " +
        "(0xC0000135). Reinstall LinkTalk; the installer must include the Microsoft Visual C++ runtime."
      );
    }
    throw err;
  }
  console.log("[INIT] Worker created with PID:", ns.bridgeControl.worker.pid);
  console.log(`[INIT] RTC ports: ${RTC_PORT_RANGE.start}-${RTC_PORT_RANGE.end}`);
  console.log(
    CLIENT_ICE_CONFIG.iceServers.length > 0
      ? `[INIT] Browser ICE: ${CLIENT_ICE_CONFIG.iceServers.length} configured server(s), policy ${CLIENT_ICE_CONFIG.iceTransportPolicy}`
      : "[INIT] Browser ICE: direct connection candidates"
  );

  ns.bridgeControl.router = await ns.bridgeControl.worker.createRouter({
    mediaCodecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
    ],
  });
  console.log("[INIT] Router created");
})();
Object.assign(ns.mediaInit, {
  mediaReadyPromise,
  warnIfDockerAnnouncedIpLooksInternal,
});
