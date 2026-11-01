/**
 * LinkTalk server — TLS, HTTP(S)-сервер и Socket.IO
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const fs = require("fs");
const path = require("path");
const socketIO = require("socket.io");
const os = require("os");
const selfsigned = require("selfsigned");
const { getDataDir } = require("../dataPaths");
const { createWebServer } = require("../webAccess");
const { normalizeTallyBus } = require("../tallyState");
const { getAllUsers, isUserInProduction, getUserByName } = require("../dbHandler");
const ns = require("../ns");
const { app } = ns.base;
const { scheduleAdminStatusBroadcast } = ns.sessions;
const { clearCompanionStatusTimer, extractCompanionApiKeyFromSocket, markCompanionSocketSeen, resolveCompanionAuth, resolveCompanionProduction } = ns.companionAuth;
const { buildCompanionSnapshotForAuth, emitCompanionUserState, isCompanionAddressableUser } = ns.companionState;
const { WEB_ACCESS, emitCompanionTallyEvent, emitProductionTallyState, mdnsHostname, tallyState } = ns.listenConfig;

// Create a self-signed certificate if none exists yet.
// Keep certificates in the per-user app data directory (writable across platforms).
const certDir = path.join(getDataDir(), "certs");
const keyPath = path.join(certDir, "key.pem");
const certPath = path.join(certDir, "cert.pem");

if (WEB_ACCESS.tlsMode === "internal" && !fs.existsSync(certDir)) {
  fs.mkdirSync(certDir, { recursive: true });
}

function isLikelyIPv4Address(value) {
  return typeof value === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim());
}

async function buildSelfSignedTlsCertificate() {
  const configuredPublicIp = typeof process.env.PUBLIC_IP === "string"
    ? process.env.PUBLIC_IP.trim()
    : "";
  const hostnames = new Set(["localhost"]);
  const ipAddresses = new Set(["127.0.0.1"]);

  const maybeAddHostOrIp = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (isLikelyIPv4Address(trimmed)) {
      ipAddresses.add(trimmed);
      return;
    }
    hostnames.add(trimmed);
  };

  maybeAddHostOrIp(mdnsHostname);
  maybeAddHostOrIp(os.hostname());
  maybeAddHostOrIp(configuredPublicIp);
  ns.networkUtils.getLocalIPv4Addresses().forEach((address) => maybeAddHostOrIp(address));

  const preferredCommonName =
    (configuredPublicIp && configuredPublicIp.trim()) ||
    mdnsHostname ||
    os.hostname() ||
    "localhost";

  const altNames = [
    ...Array.from(hostnames).map((value) => ({ type: 2, value })),
    ...Array.from(ipAddresses).map((ip) => ({ type: 7, ip })),
  ];

  return selfsigned.generate(
    [{ name: "commonName", value: preferredCommonName }],
    {
      // Native WebCrypto generates the key asynchronously without blocking startup.
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: false },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
        },
        {
          name: "subjectAltName",
          altNames,
        },
      ],
    }
  );
}

// Attach routes and Socket.IO immediately, but listen only after TLS is ready.
const server = createWebServer(app, WEB_ACCESS, () => ({}), mdnsHostname || "localhost");
const tlsReadyPromise = (async () => {
  if (WEB_ACCESS.tlsMode === "proxy") return;
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    const pems = await buildSelfSignedTlsCertificate();
    fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
    fs.writeFileSync(certPath, pems.cert, { mode: 0o600 });
    console.log("ℹ️  Generated self-signed TLS certificate in ./certs");
  }
  server.setSecureContext({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) });
})();
const io = socketIO(server, { serveClient: false });

ns.companionAuth.companionNamespace = io.of("/companion");
ns.companionAuth.companionNamespace.use((socket, next) => {
  const candidate = extractCompanionApiKeyFromSocket(socket);
  const auth = resolveCompanionAuth(candidate);
  if (!candidate || !auth) {
    return next(new Error("unauthorized"));
  }
  try {
    const requestedProduction = socket.handshake?.auth?.productionId
      ?? socket.handshake?.query?.productionId
      ?? null;
    socket.data.productionId = resolveCompanionProduction(auth, requestedProduction);
    socket.data.companionAuth = auth;
  } catch (err) {
    return next(new Error(err.message || "production access denied"));
  }
  next();
});
ns.companionAuth.companionNamespace.on("connection", (socket) => {
  socket.data.connectedAt = Date.now();
  markCompanionSocketSeen(socket);
  const announcedName = socket.handshake?.auth?.instanceName
    || socket.handshake?.auth?.clientName
    || socket.handshake?.auth?.name;
  socket.data.instanceName = typeof announcedName === "string" && announcedName.trim()
    ? announcedName.trim().slice(0, 120)
    : null;
  socket.onAny(() => {
    markCompanionSocketSeen(socket);
  });
  socket.conn?.on?.("packet", () => {
    markCompanionSocketSeen(socket);
  });
  scheduleAdminStatusBroadcast("companion-connected");
  socket.emit("snapshot", buildCompanionSnapshotForAuth(
    socket.data?.companionAuth || null,
    socket.data?.productionId ?? null
  ));
  socket.on("request-snapshot", () => {
    markCompanionSocketSeen(socket);
    socket.emit("snapshot", buildCompanionSnapshotForAuth(
      socket.data?.companionAuth || null,
      socket.data?.productionId ?? null
    ));
  });
  socket.on("disconnect", () => {
    clearCompanionStatusTimer(socket);
    scheduleAdminStatusBroadcast("companion-disconnected");
  });
});

app.post("/cut-camera", (req, res) => {
  const { user } = req.body;
  if (typeof user !== "string") {
    return res.status(400).json({ error: "user must be provided" });
  }

  let bus;
  let productionId;
  try {
    bus = normalizeTallyBus(req.body?.bus);
    productionId = resolveCompanionProduction({ type: "api-key" }, req.body?.productionId);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message });
  }

  const nextUser = user.trim() || null;
  if (nextUser) {
    const matchedUser = getUserByName(nextUser);
    if (!isCompanionAddressableUser(matchedUser)) {
      return res.status(404).json({ error: "User not found" });
    }
    if (productionId !== null && !isUserInProduction(matchedUser.id, productionId)) {
      return res.status(400).json({ error: "User is not a member of this production" });
    }
  }

  console.log(`[TALLY] ${bus.toUpperCase()} request for ${nextUser || "off"} in production ${productionId}`);
  const updated = tallyState.set(productionId, bus, nextUser);
  emitProductionTallyState(productionId);

  const payload = {
    at: new Date().toISOString(),
    productionId,
    bus,
    previousUser: updated.previousUser,
    user: updated.user,
    pgmUser: updated.pgmUser,
    prvUser: updated.prvUser,
  };
  emitCompanionTallyEvent(productionId, payload);

  if (updated.previousUser !== updated.user) {
    const touchedNames = new Set([updated.previousUser, updated.user].filter(Boolean));
    if (touchedNames.size) {
      const allUsers = getAllUsers();
      allUsers.forEach((u) => {
        if (touchedNames.has(u.name) && (productionId === null || isUserInProduction(u.id, productionId))) {
          emitCompanionUserState(u.id, "cut-camera-changed", u.name);
        }
      });
    }
  }

  res.json(payload);
});


app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});
Object.assign(ns.webServer, {
  io,
  isLikelyIPv4Address,
  server,
  tlsReadyPromise,
});
