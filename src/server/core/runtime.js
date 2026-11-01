/**
 * LinkTalk server — версия, ICE-конфиг и поиск бинарника mediasoup-worker
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const fs = require("fs");
const path = require("path");
const { resolveServerAppVersion } = require("../appVersion");
const { getDataDir } = require("../dataPaths");
const { resolveClientIceConfig } = require("../webrtcConfig");
const { syncRuntimeExecutable } = require("../runtimeWorker");
const ns = require("../ns");

const SERVER_APP_VERSION = resolveServerAppVersion();
const CLIENT_ICE_CONFIG = resolveClientIceConfig(process.env);

const workerName = process.platform === "win32" ? "mediasoup-worker.exe" : "mediasoup-worker";
const windowsRuntimeDllPattern =
  /^(?:api-ms-win-crt-[a-z0-9-]+|concrt140|msvcp140(?:_[a-z0-9_]+)?|ucrtbase|vcruntime140(?:_[a-z0-9_]+)?)\.dll$/i;

// 1) Find the mediasoup entry file (instead of package.json)
const mediasoupEntry = require.resolve("mediasoup");

// 2) Walk up to the package root (where package.json lives)
ns.runtime.mediasoupPkgDir = path.dirname(mediasoupEntry);
const root = path.parse(ns.runtime.mediasoupPkgDir).root;
while (
  !fs.existsSync(path.join(ns.runtime.mediasoupPkgDir, "package.json")) &&
  ns.runtime.mediasoupPkgDir !== root
) {
  ns.runtime.mediasoupPkgDir = path.dirname(ns.runtime.mediasoupPkgDir);
}

// 3) Build the default worker path (without "node")
ns.runtime.workerBin = path.join(ns.runtime.mediasoupPkgDir, "worker", "out", "Release", workerName);

// 4) pkg bundle: copy the binary into a writable folder
if (process.pkg) {
  const execDir = path.dirname(process.execPath);
  const sources = [
    ns.runtime.workerBin,
    path.join(execDir, "worker", "out", "Release", workerName),
    path.join(execDir, workerName)
  ];
  const sourceBin = sources.find((candidate) => fs.existsSync(candidate));

  if (!sourceBin) {
    throw new Error(
      `mediasoup worker binary missing from pkg bundle.\n` +
      `Checked: ${sources.join(", ")}`
    );
  }

  const runtimeDir = path.join(getDataDir(), "runtime");
  const dest = path.join(runtimeDir, workerName);
  const workerSync = syncRuntimeExecutable(sourceBin, dest);
  if (workerSync.updated) {
    console.log(`[INIT] Updated mediasoup worker runtime: ${dest}`);
  }

  // The packaged worker is copied out of pkg's virtual filesystem before it
  // can be executed. On Windows the loader resolves app-local DLLs relative
  // to that copied executable, not relative to the tray app or its resources
  // directory. Keep the bundled MSVC/UCRT files beside the runtime worker.
  if (process.platform === "win32") {
    const runtimeSourceDirs = [
      path.dirname(sourceBin),
      execDir,
      path.join(execDir, "binaries"),
    ];
    const copiedRuntimeDlls = new Set();

    for (const sourceDir of runtimeSourceDirs) {
      if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) continue;
      for (const file of fs.readdirSync(sourceDir)) {
        if (!windowsRuntimeDllPattern.test(file)) continue;
        const normalizedFile = file.toLowerCase();
        if (copiedRuntimeDlls.has(normalizedFile)) continue;
        fs.writeFileSync(path.join(runtimeDir, file), fs.readFileSync(path.join(sourceDir, file)));
        copiedRuntimeDlls.add(normalizedFile);
      }
    }
  }
  ns.runtime.workerBin = dest;
}

// 6) Set the path (must happen before the first mediasoup require)
process.env.MEDIASOUP_WORKER_BIN = ns.runtime.workerBin;

// 7) Fail fast with a clear error if the binary is missing
if (!fs.existsSync(process.env.MEDIASOUP_WORKER_BIN)) {
  throw new Error(
    `mediasoup worker binary not found at: ${process.env.MEDIASOUP_WORKER_BIN}\n` +
    `Expected: node_modules/mediasoup/worker/out/Release/${workerName}`
  );
}

const mediasoup = require("mediasoup");
Object.assign(ns.runtime, {
  CLIENT_ICE_CONFIG,
  SERVER_APP_VERSION,
  mediasoup,
});
