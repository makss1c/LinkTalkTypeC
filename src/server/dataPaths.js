const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR_NAME = "linktalk";
// Установки, сделанные до переименования, продолжают пользоваться старой папкой данных.
const LEGACY_APP_DIR_NAME = "talktome";

function resolveAppDir(base) {
  const current = path.join(base, APP_DIR_NAME);
  const legacy = path.join(base, LEGACY_APP_DIR_NAME);
  if (!fs.existsSync(current) && fs.existsSync(legacy)) {
    return legacy;
  }
  return current;
}

function getDataDir() {
  const override = process.env.TALKTOME_DATA_DIR;
  if (override && String(override).trim()) {
    return path.resolve(override);
  }

  if (process.platform === "darwin") {
    return resolveAppDir(path.join(os.homedir(), "Library", "Application Support"));
  }

  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(os.homedir(), "AppData", "Local");
    return resolveAppDir(base);
  }

  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return resolveAppDir(base);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDataFile(filename) {
  const dir = ensureDir(getDataDir());
  return path.join(dir, filename);
}

module.exports = {
  getDataDir,
  ensureDir,
  getDataFile,
};
