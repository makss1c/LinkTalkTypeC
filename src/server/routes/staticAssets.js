/**
 * LinkTalk server — маршруты статики, клиент socket.io, about
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { projectRoot } = require("../projectPaths");
const { serializeDefaultClientSettingsScript } = require("../defaultClientSettings");
const ns = require("../ns");
const { app, execPublicDir } = ns.base;
const { loadRuntimeConfig } = ns.config;

app.get("/", (req, res) => {
  const indexPath = path.join(ns.config.publicDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    return res.status(404).send("Cannot GET /");
  }
  try {
    const html = fs.readFileSync(indexPath, "utf8");
    res.type("html").send(html);
  } catch (err) {
    res.status(500).send("Failed to load index.html");
  }
});

app.get("/default-client-settings.js", (req, res) => {
  const config = loadRuntimeConfig() || {};
  res.setHeader("Cache-Control", "no-store");
  res.type("application/javascript").send(
    serializeDefaultClientSettingsScript(config.defaultClientSettings)
  );
});

function findSocketIoClientPath() {
  const socketIoEntry = require.resolve("socket.io");
  let socketIoPkgDir = path.dirname(socketIoEntry);
  const root = path.parse(socketIoPkgDir).root;
  while (
    !fs.existsSync(path.join(socketIoPkgDir, "package.json")) &&
    socketIoPkgDir !== root
  ) {
    socketIoPkgDir = path.dirname(socketIoPkgDir);
  }
  const candidate = path.join(socketIoPkgDir, "client-dist", "socket.io.js");
  return fs.existsSync(candidate) ? candidate : null;
}

function stripSocketIoSourceMapReference(source) {
  if (typeof source !== "string") return source;
  return source.replace(/\n\/\/# sourceMappingURL=socket\.io\.js\.map\s*$/, "\n");
}

const socketIoClientPath = findSocketIoClientPath();
const socketIoClientContents = (() => {
  if (!socketIoClientPath) return null;
  try {
    return stripSocketIoSourceMapReference(
      fs.readFileSync(socketIoClientPath, "utf8")
    );
  } catch (err) {
    console.warn(`[SOCKET.IO] Failed to read client script: ${err.message}`);
    return null;
  }
})();

if (process.pkg) {
  if (socketIoClientContents) {
    const destPath = path.join(execPublicDir, "socket.io.js");
    try {
      if (!fs.existsSync(destPath)) {
        fs.writeFileSync(destPath, socketIoClientContents, "utf8");
      }
    } catch (err) {
      console.warn(`[SOCKET.IO] Failed to copy client script: ${err.message}`);
    }
  } else {
    console.warn("[SOCKET.IO] client script not found; /socket.io.js will 404");
  }
} else if (socketIoClientContents) {
  app.get("/socket.io.js", (req, res) => {
    res.type("application/javascript").send(socketIoClientContents);
  });
} else {
  console.warn("[SOCKET.IO] client script not found; /socket.io.js will 404");
}

if (process.pkg) {
  app.get("/socket.io.js", (req, res) => {
    const diskPath = path.join(execPublicDir, "socket.io.js");
    if (fs.existsSync(diskPath)) {
      return res.sendFile(diskPath);
    }
    if (socketIoClientContents) {
      return res.type("application/javascript").send(socketIoClientContents);
    }
    res.sendStatus(404);
  });
}

// LinkTalk: страница «О программе» (разработчик, контакты, происхождение кода).
app.get(["/about", "/about/"], (req, res) => {
  res.sendFile(path.join(ns.config.publicDir, "about.html"));
});
app.get("/about.json", (req, res) => {
  res.json(require("../branding").about());
});

app.use(express.static(ns.config.publicDir));

const nodeModulesDir = path.join(projectRoot, "node_modules");
if (fs.existsSync(nodeModulesDir)) {
  app.use("/node_modules", express.static(nodeModulesDir));
}