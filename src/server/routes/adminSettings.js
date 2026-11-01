/**
 * LinkTalk server — настройки админки, резервные копии, импорт и экспорт
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const path = require("path");
const QRCode = require("qrcode");
const { normalizeAutomaticBackupSettings, createAutomaticConfigBackup } = require("../automaticConfigBackup");
const { buildMediaNetworkQrTargets, normalizeConnectUrl, selectAdminQrUrl } = require("../qrConnectUrl");
const { normalizeWebAccess, requestConnectOrigin } = require("../webAccess");
const { isRunningInContainer } = require("../runtimeEnvironment");
const { normalizeSocketAddress } = require("../mediaNetwork");
const { normalizeConfiguredDefaultClientSettings, resolveDefaultClientSettings } = require("../defaultClientSettings");
const { getOrCreateGuestProfile, getAllUsers, getUserById, getPrimaryProduction, exportDatabaseSnapshot, importDatabaseSnapshot } = require("../dbHandler");
const ns = require("../ns");
const { app, dataDir } = ns.base;
const { addEntityToPrimaryProductionWhenSingle, areMultipleProductionsEnabled, buildMediaNetworkRequestWarning, getActiveRtcAddresses, getAvailableMediaNetworkInterfaces, getConfigPath, getEffectiveConferencesForPeer, loadRuntimeConfig, normalizeMdnsSetting, normalizeMediaAnnouncedAddress, normalizeMediaInterfaceName, normalizeMediaNetworkMode, normalizeRtcPortRange, parseOptionalPort, parseRequiredPort, resolveGuestLoginSettings, resolveSavedMediaNetworkConfig, resolveSavedRtcPortRange, resolveTransportAnnouncedAddress, saveRuntimeConfig } = ns.config;
const { requireAdmin, requireAdminSession } = ns.sessions;
const { isOperatorPeer } = ns.talkTargets;
const { broadcastRuntimeUserStates } = ns.companionState;
const { HTTPS_PORT, RTC_PORT_RANGE, WEB_ACCESS, WEB_PROTOCOL, emitPeerTallyState, mdnsHostname } = ns.listenConfig;
const { emitTargetRearrangePermission } = ns.routesUsers;

app.get("/admin/settings/mdns", requireAdmin, (req, res) => {
  const config = loadRuntimeConfig() || {};
  const defaultHost = isRunningInContainer() ? "off" : "intercom.local";
  const configuredHost = normalizeMdnsSetting(config.mdnsHost) || defaultHost;
  const activeHost = mdnsHostname || "off";

  res.json({
    mdnsHost: configuredHost,
    activeMdnsHost: activeHost,
    restartRequired: configuredHost !== activeHost,
    configPath: getConfigPath(),
    runningInContainer: isRunningInContainer(),
  });
});

function buildBackendConnectUrl(host) {
  if (typeof host !== "string") return "";
  const trimmed = host.trim();
  if (!trimmed) return "";
  return `${WEB_PROTOCOL}://${trimmed}:${HTTPS_PORT}`;
}

function resolveConfiguredAdminPublicConnectUrl() {
  return normalizeConnectUrl(
    WEB_ACCESS.publicUrl
  );
}

function resolveAdminRequestConnectUrl(req) {
  return normalizeConnectUrl(requestConnectOrigin(req, WEB_ACCESS));
}

function resolvePreferredAdminQrIpAddress(activeAddress) {
  const candidates = [];
  const seen = new Set();

  const addCandidate = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  addCandidate(activeAddress);
  ns.networkUtils.getStartupHosts().forEach(addCandidate);
  ns.networkUtils.getLocalIPv4Addresses().forEach(addCandidate);

  return candidates.find(ns.webServer.isLikelyIPv4Address) || null;
}

async function buildAdminMediaNetworkQrPayload(activeAddresses, req = null) {
  const activeAddress = activeAddresses[0] || "";
  const qrUrl = resolveAdminConnectUrl(activeAddress, req);
  const configuredPublicConnectUrl = resolveConfiguredAdminPublicConnectUrl();
  const requestConnectUrl = resolveAdminRequestConnectUrl(req);
  const qrIpAddress = resolvePreferredAdminQrIpAddress(activeAddress);
  const publicConnectUrl = configuredPublicConnectUrl || requestConnectUrl;
  const activeMdnsHost = mdnsHostname || "off";
  const mdnsUrl = mdnsHostname ? buildBackendConnectUrl(mdnsHostname) : "";

  let qrCodeDataUrl = null;
  if (qrUrl) {
    try {
      qrCodeDataUrl = await QRCode.toDataURL(qrUrl, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 640,
        color: {
          dark: "#0f172a",
          light: "#ffffff",
        },
      });
    } catch (error) {
      console.warn("[ADMIN] Failed to generate media network QR code:", error?.message || error);
    }
  }

  const targets = buildMediaNetworkQrTargets({
    addresses: activeAddresses, protocol: WEB_PROTOCOL, port: HTTPS_PORT,
    tlsMode: WEB_ACCESS.tlsMode, publicUrl: configuredPublicConnectUrl, proxyUrl: qrUrl,
  });
  const qrCodes = await Promise.all(targets.map(async target => {
    if (target.qrUrl === qrUrl) return { ...target, qrCodeDataUrl };
    try {
      return { ...target, qrCodeDataUrl: await QRCode.toDataURL(target.qrUrl, {
        errorCorrectionLevel: "M", margin: 1, width: 640,
        color: { dark: "#0f172a", light: "#ffffff" },
      }) };
    } catch (error) {
      console.warn("[ADMIN] Failed to generate media network QR code:", error?.message || error);
      return { ...target, qrCodeDataUrl: null };
    }
  }));

  return {
    httpsPort: HTTPS_PORT,
    activeMdnsHost,
    qrIpAddress,
    publicConnectUrl: publicConnectUrl || null,
    qrUrl: qrUrl || null,
    mdnsUrl: mdnsUrl || null,
    qrCodeDataUrl,
    qrCodes,
  };
}

function resolveAdminConnectUrl(activeAddress, req = null) {
  const qrIpAddress = resolvePreferredAdminQrIpAddress(activeAddress);
  const configuredPublicConnectUrl = resolveConfiguredAdminPublicConnectUrl();
  const requestConnectUrl = resolveAdminRequestConnectUrl(req);
  const adapterConnectUrl = buildBackendConnectUrl(qrIpAddress);
  if (WEB_ACCESS.tlsMode === "proxy") {
    if (configuredPublicConnectUrl) return configuredPublicConnectUrl;
    if (requestConnectUrl.startsWith("https://")) return requestConnectUrl;
  }
  return selectAdminQrUrl({
    configuredUrl: configuredPublicConnectUrl,
    requestUrl: requestConnectUrl,
    adapterUrl: adapterConnectUrl,
  });
}

function webAccessSettings() {
  const saved = normalizeWebAccess(loadRuntimeConfig() || {});
  const active = Object.fromEntries(Object.keys(saved).map(key => [key, WEB_ACCESS[key]]));
  return {
    saved, active, environmentOverrides: WEB_ACCESS.environmentOverrides,
    restartRequired: Object.keys(saved).some(key => !WEB_ACCESS.environmentOverrides.includes(key) && saved[key] !== active[key]),
  };
}

app.get("/admin/settings/web-access", requireAdmin, (req, res) => {
  res.json(webAccessSettings());
});

app.put("/admin/settings/web-access", requireAdmin, (req, res) => {
  try {
    const current = loadRuntimeConfig() || {};
    const next = normalizeWebAccess(req.body);
    for (const key of WEB_ACCESS.environmentOverrides) next[key] = normalizeWebAccess(current)[key];
    saveRuntimeConfig({ ...current, ...next });
    res.json(webAccessSettings());
  } catch (error) {
    res.status(400).json({ error: error.message || "Failed to save web access settings" });
  }
});

app.get("/admin/settings/media-network", requireAdmin, async (req, res) => {
  const config = loadRuntimeConfig() || {};
  const saved = resolveSavedMediaNetworkConfig(config);
  const active = resolveTransportAnnouncedAddress();
  const environmentOverride = active.source === "env";
  const restartRequired = environmentOverride
    ? false
    : (
      saved.mode !== active.mode
      || (saved.mode === "interface" && saved.interfaceName !== active.interfaceName)
      || (saved.mode === "manual" && saved.announcedAddress !== (active.announcedAddress || ""))
    );
  const qrPayload = await buildAdminMediaNetworkQrPayload(getActiveRtcAddresses(active), req);

  res.json({
    mediaNetworkMode: saved.mode,
    mediaInterfaceName: saved.interfaceName,
    mediaAnnouncedAddress: saved.announcedAddress,
    activeMediaNetworkMode: active.mode,
    activeMediaInterfaceName: active.interfaceName,
    activeAnnouncedAddress: active.announcedAddress,
    activeRtcAddresses: getActiveRtcAddresses(active),
    activeResolutionError: active.error,
    mediaNetworkWarning: buildMediaNetworkRequestWarning(active, req),
    requestLocalAddress: normalizeSocketAddress(req.socket?.localAddress) || null,
    availableInterfaces: getAvailableMediaNetworkInterfaces(),
    restartRequired,
    environmentOverride,
    runningInContainer: isRunningInContainer(),
    configPath: getConfigPath(),
    ...qrPayload,
  });
});

app.get("/admin/settings/rtc-ports", requireAdmin, (req, res) => {
  const config = loadRuntimeConfig() || {};
  const saved = resolveSavedRtcPortRange(config);
  const environmentOverride = RTC_PORT_RANGE.source === "env";

  res.json({
    rtcPortStart: saved.start,
    rtcPortCount: saved.count,
    rtcPortEnd: saved.end,
    activeRtcPortStart: RTC_PORT_RANGE.start,
    activeRtcPortCount: RTC_PORT_RANGE.count,
    activeRtcPortEnd: RTC_PORT_RANGE.end,
    restartRequired: environmentOverride
      ? false
      : saved.start !== RTC_PORT_RANGE.start || saved.count !== RTC_PORT_RANGE.count,
    environmentOverride,
    configPath: getConfigPath(),
  });
});

app.get("/admin/settings/guest-login", requireAdmin, (req, res) => {
  try {
    const config = loadRuntimeConfig() || {};
    const settings = resolveGuestLoginSettings(config, { createProfile: true, persist: true });
    res.json({
      enabled: settings.enabled,
      profileUserId: settings.profileUserId,
      profileName: settings.profileName,
      configPath: getConfigPath(),
    });
  } catch (err) {
    console.error("Error loading guest login setting:", err);
    res.status(500).json({ error: "Failed to load guest login setting" });
  }
});

app.get("/admin/settings/default-client", requireAdmin, (req, res) => {
  const config = loadRuntimeConfig() || {};
  res.json({
    settings: resolveDefaultClientSettings(config.defaultClientSettings),
    configured: Object.prototype.hasOwnProperty.call(config, "defaultClientSettings"),
    configPath: getConfigPath(),
  });
});

app.get("/admin/settings/multiple-productions", requireAdminSession, (req, res) => {
  const primaryProduction = getPrimaryProduction();
  res.json({
    enabled: areMultipleProductionsEnabled(),
    configurable: Boolean(req.adminSession.isGlobalAdmin),
    primaryProductionId: primaryProduction?.id ?? null,
    configPath: getConfigPath(),
  });
});

app.put("/admin/settings/mdns", requireAdmin, (req, res) => {
  const nextHost = normalizeMdnsSetting(req.body?.mdnsHost);
  if (!nextHost) {
    return res.status(400).json({ error: "Invalid mDNS name. Use letters, numbers, hyphens and optional dots, or 'off'." });
  }
  const currentConfig = loadRuntimeConfig() || {};
  const updatedConfig = {
    ...currentConfig,
    mdnsHost: nextHost,
  };

  try {
    const configPath = saveRuntimeConfig(updatedConfig);
    return res.json({
      mdnsHost: nextHost,
      activeMdnsHost: mdnsHostname || "off",
      restartRequired: nextHost !== (mdnsHostname || "off"),
      configPath,
      runningInContainer: isRunningInContainer(),
    });
  } catch (err) {
    console.error("Error saving mDNS setting:", err);
    return res.status(500).json({ error: "Failed to save mDNS setting" });
  }
});

app.put("/admin/settings/media-network", requireAdmin, (req, res) => {
  const nextMode = normalizeMediaNetworkMode(req.body?.mediaNetworkMode);
  if (!nextMode) {
    return res.status(400).json({ error: "Invalid media network mode" });
  }

  const nextInterfaceName = normalizeMediaInterfaceName(req.body?.mediaInterfaceName);
  const nextAnnouncedAddress = normalizeMediaAnnouncedAddress(req.body?.mediaAnnouncedAddress);
  if (nextMode === "interface" && !nextInterfaceName) {
    return res.status(400).json({ error: "Please choose a network adapter" });
  }
  if (nextMode === "manual" && !nextAnnouncedAddress) {
    return res.status(400).json({ error: "Please enter a manual IP address or hostname" });
  }

  const currentConfig = loadRuntimeConfig() || {};
  const updatedConfig = {
    ...currentConfig,
    mediaNetworkMode: nextMode,
  };
  if (nextMode === "interface") {
    updatedConfig.mediaInterfaceName = nextInterfaceName;
    delete updatedConfig.mediaAnnouncedAddress;
  } else if (nextMode === "manual") {
    updatedConfig.mediaAnnouncedAddress = nextAnnouncedAddress;
    delete updatedConfig.mediaInterfaceName;
  } else {
    delete updatedConfig.mediaInterfaceName;
    delete updatedConfig.mediaAnnouncedAddress;
  }

  try {
    const configPath = saveRuntimeConfig(updatedConfig);
    const active = resolveTransportAnnouncedAddress();
    const environmentOverride = active.source === "env";
    return res.json({
      mediaNetworkMode: nextMode,
      mediaInterfaceName: nextMode === "interface" ? nextInterfaceName : "",
      mediaAnnouncedAddress: nextMode === "manual" ? nextAnnouncedAddress : "",
      activeMediaNetworkMode: active.mode,
      activeMediaInterfaceName: active.interfaceName,
      activeAnnouncedAddress: active.announcedAddress,
      activeRtcAddresses: getActiveRtcAddresses(active),
      activeResolutionError: active.error,
      availableInterfaces: getAvailableMediaNetworkInterfaces(),
      restartRequired: !environmentOverride,
      environmentOverride,
      runningInContainer: isRunningInContainer(),
      configPath,
    });
  } catch (err) {
    console.error("Error saving media network setting:", err);
    return res.status(500).json({ error: "Failed to save media network setting" });
  }
});

app.put("/admin/settings/rtc-ports", requireAdmin, (req, res) => {
  const nextRange = normalizeRtcPortRange(req.body?.rtcPortStart, req.body?.rtcPortCount);
  if (nextRange.error) {
    return res.status(400).json({ error: nextRange.error });
  }

  const currentConfig = loadRuntimeConfig() || {};
  const updatedConfig = {
    ...currentConfig,
    rtcPortStart: nextRange.start,
    rtcPortCount: nextRange.count,
  };

  try {
    const configPath = saveRuntimeConfig(updatedConfig);
    const environmentOverride = RTC_PORT_RANGE.source === "env";
    return res.json({
      rtcPortStart: nextRange.start,
      rtcPortCount: nextRange.count,
      rtcPortEnd: nextRange.end,
      activeRtcPortStart: RTC_PORT_RANGE.start,
      activeRtcPortCount: RTC_PORT_RANGE.count,
      activeRtcPortEnd: RTC_PORT_RANGE.end,
      restartRequired: !environmentOverride && (
        nextRange.start !== RTC_PORT_RANGE.start ||
        nextRange.count !== RTC_PORT_RANGE.count
      ),
      environmentOverride,
      configPath,
    });
  } catch (err) {
    console.error("Error saving RTC port setting:", err);
    return res.status(500).json({ error: "Failed to save RTC port setting" });
  }
});

app.put("/admin/settings/guest-login", requireAdmin, (req, res) => {
  const enabled = req.body?.enabled === true;

  try {
    const currentConfig = loadRuntimeConfig() || {};
    const profile = getOrCreateGuestProfile();
    addEntityToPrimaryProductionWhenSingle("user", profile.id);
    const updatedConfig = {
      ...currentConfig,
      guestLogin: {
        ...(currentConfig.guestLogin && typeof currentConfig.guestLogin === "object" ? currentConfig.guestLogin : {}),
        enabled,
        profileUserId: profile.id,
      },
    };
    const configPath = saveRuntimeConfig(updatedConfig);
    return res.json({
      enabled,
      profileUserId: profile.id,
      profileName: profile.name,
      configPath,
    });
  } catch (err) {
    console.error("Error saving guest login setting:", err);
    return res.status(500).json({ error: "Failed to save guest login setting" });
  }
});

app.put("/admin/settings/default-client", requireAdmin, (req, res) => {
  try {
    const settings = normalizeConfiguredDefaultClientSettings(req.body, { strict: true });
    const currentConfig = loadRuntimeConfig() || {};
    const updatedConfig = {
      ...currentConfig,
      defaultClientSettings: settings,
    };
    const configPath = saveRuntimeConfig(updatedConfig);
    getAllUsers().forEach(emitTargetRearrangePermission);
    return res.json({
      settings: resolveDefaultClientSettings(settings),
      configured: true,
      configPath,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Invalid default client settings" });
  }
});

app.put("/admin/settings/multiple-productions", requireAdmin, (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be boolean" });
  }
  const enabled = req.body?.enabled === true;
  try {
    const currentConfig = loadRuntimeConfig() || {};
    const configPath = saveRuntimeConfig({
      ...currentConfig,
      multipleProductions: enabled,
    });
    if (!enabled) {
      const primaryProductionId = getPrimaryProduction()?.id ?? null;
      for (const peer of ns.bridgeControl.peers.values()) {
        if (!isOperatorPeer(peer)) continue;
        const hadDifferentProduction = String(peer.productionId ?? "") !== String(primaryProductionId ?? "");
        peer.productionId = primaryProductionId;
        if (hadDifferentProduction) {
          peer.socket.emit("active-production-reset", {
            productionId: primaryProductionId,
            reason: "multiple-productions-disabled",
          });
        }
        peer.socket.emit("user-targets-updated");
        peer.socket.emit("conference-list", getEffectiveConferencesForPeer(peer));
        peer.socket.emit("conference-members-updated", { conferenceId: null });
        emitPeerTallyState(peer);
      }
      ns.producerRouting.reconcileAllProducerRecipients();
      broadcastRuntimeUserStates("multiple-productions-disabled");
    }
    ns.entityNotifications.notifyAvailableProductionsChanged();
    return res.json({ enabled, configurable: true, configPath });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to save production mode" });
  }
});

function buildConfigBackupBundle() {
  return {
    format: "linktalk-config",
    version: 1,
    exportedAt: new Date().toISOString(),
    serverConfig: loadRuntimeConfig() || {},
    database: exportDatabaseSnapshot(),
  };
}

const automaticConfigBackup = createAutomaticConfigBackup({
  directory: path.join(dataDir, "backups"),
  getSettings: () => (loadRuntimeConfig() || {}).automaticBackup,
  buildBundle: buildConfigBackupBundle,
});
automaticConfigBackup.schedule();

app.get("/admin/settings/automatic-backup", requireAdmin, (req, res) => {
  res.json(automaticConfigBackup.getStatus());
});

app.put("/admin/settings/automatic-backup", requireAdmin, (req, res) => {
  let settings;
  try {
    settings = normalizeAutomaticBackupSettings(req.body, { strict: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const currentConfig = loadRuntimeConfig() || {};
    const wasEnabled = normalizeAutomaticBackupSettings(currentConfig.automaticBackup).enabled;
    saveRuntimeConfig({ ...currentConfig, automaticBackup: settings });
    const status = automaticConfigBackup.settingsChanged({ createImmediately: settings.enabled && !wasEnabled });
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to save automatic backup settings" });
  }
});

app.get("/admin/config/export", requireAdmin, (req, res) => {
  try {
    const bundle = buildConfigBackupBundle();

    const stamp = bundle.exportedAt.replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"linktalk-config-${stamp}.json\"`);
    res.send(JSON.stringify(bundle, null, 2));
  } catch (err) {
    console.error("Error exporting config:", err);
    res.status(500).json({ error: "Failed to export configuration" });
  }
});

app.post("/admin/config/import", requireAdmin, (req, res) => {
  const bundle = req.body;
  if (!bundle || typeof bundle !== "object") {
    return res.status(400).json({ error: "Invalid import payload" });
  }
  if (bundle.format !== "linktalk-config" && bundle.format !== "talktome-config") {
    return res.status(400).json({ error: "Unsupported config file" });
  }
  if (!bundle.database || typeof bundle.database !== "object") {
    return res.status(400).json({ error: "Config file is missing database data" });
  }

  try {
    const currentConfig = loadRuntimeConfig() || {};
    const nextConfig = { ...currentConfig };

    if (bundle.serverConfig && typeof bundle.serverConfig === "object") {
      const importedWebAccess = normalizeWebAccess({ ...nextConfig, ...bundle.serverConfig });
      Object.assign(nextConfig, importedWebAccess);
      if (Object.prototype.hasOwnProperty.call(bundle.serverConfig, "httpsPort")) {
        const httpsPort = parseRequiredPort(bundle.serverConfig.httpsPort, nextConfig.httpsPort ?? 443);
        nextConfig.httpsPort = httpsPort;
      }

      if (Object.prototype.hasOwnProperty.call(bundle.serverConfig, "httpPort")) {
        nextConfig.httpPort = parseOptionalPort(bundle.serverConfig.httpPort);
      }

      if (Object.prototype.hasOwnProperty.call(bundle.serverConfig, "mdnsHost")) {
        const mdnsHost = normalizeMdnsSetting(bundle.serverConfig.mdnsHost);
        if (!mdnsHost) {
          return res.status(400).json({ error: "Config file contains an invalid mDNS name" });
        }
        nextConfig.mdnsHost = mdnsHost;
      }

      if (
        Object.prototype.hasOwnProperty.call(bundle.serverConfig, "mediaNetworkMode")
        || Object.prototype.hasOwnProperty.call(bundle.serverConfig, "mediaInterfaceName")
        || Object.prototype.hasOwnProperty.call(bundle.serverConfig, "mediaAnnouncedAddress")
      ) {
        const importedMediaConfig = resolveSavedMediaNetworkConfig(bundle.serverConfig);
        nextConfig.mediaNetworkMode = importedMediaConfig.mode;
        if (importedMediaConfig.mode === "interface") {
          nextConfig.mediaInterfaceName = importedMediaConfig.interfaceName;
          delete nextConfig.mediaAnnouncedAddress;
        } else if (importedMediaConfig.mode === "manual") {
          nextConfig.mediaAnnouncedAddress = importedMediaConfig.announcedAddress;
          delete nextConfig.mediaInterfaceName;
        } else {
          delete nextConfig.mediaInterfaceName;
          delete nextConfig.mediaAnnouncedAddress;
        }
      }

      if (
        Object.prototype.hasOwnProperty.call(bundle.serverConfig, "rtcPortStart")
        || Object.prototype.hasOwnProperty.call(bundle.serverConfig, "rtcPortCount")
      ) {
        const importedRtcRange = normalizeRtcPortRange(
          bundle.serverConfig.rtcPortStart,
          bundle.serverConfig.rtcPortCount,
          resolveSavedRtcPortRange(nextConfig)
        );
        if (importedRtcRange.error) {
          return res.status(400).json({ error: `Config file contains an invalid RTC port range: ${importedRtcRange.error}` });
        }
        nextConfig.rtcPortStart = importedRtcRange.start;
        nextConfig.rtcPortCount = importedRtcRange.count;
      }

      if (bundle.serverConfig.guestLogin && typeof bundle.serverConfig.guestLogin === "object") {
        const importedGuestProfileId = Number(bundle.serverConfig.guestLogin.profileUserId);
        nextConfig.guestLogin = {
          enabled: bundle.serverConfig.guestLogin.enabled === true,
          profileUserId: Number.isFinite(importedGuestProfileId) ? importedGuestProfileId : null,
        };
      }

      if (Object.prototype.hasOwnProperty.call(bundle.serverConfig, "defaultClientSettings")) {
        try {
          nextConfig.defaultClientSettings = normalizeConfiguredDefaultClientSettings(
            bundle.serverConfig.defaultClientSettings,
            { strict: true }
          );
        } catch (error) {
          return res.status(400).json({
            error: `Config file contains invalid default client settings: ${error.message}`,
          });
        }
      }

      if (Object.prototype.hasOwnProperty.call(bundle.serverConfig, "multipleProductions")) {
        nextConfig.multipleProductions = bundle.serverConfig.multipleProductions === true;
      }

      if (Object.prototype.hasOwnProperty.call(bundle.serverConfig, "automaticBackup")) {
        try {
          nextConfig.automaticBackup = normalizeAutomaticBackupSettings(
            bundle.serverConfig.automaticBackup,
            { strict: true }
          );
        } catch (error) {
          return res.status(400).json({ error: `Config file contains invalid automatic backup settings: ${error.message}` });
        }
      }
    }

    importDatabaseSnapshot(bundle.database);
    if (nextConfig.guestLogin && typeof nextConfig.guestLogin === "object") {
      const configuredGuestProfile = Number.isFinite(Number(nextConfig.guestLogin.profileUserId))
        ? getUserById(Number(nextConfig.guestLogin.profileUserId))
        : null;
      if (!configuredGuestProfile?.is_guest_profile) {
        const fallbackGuestProfile = getOrCreateGuestProfile();
        nextConfig.guestLogin.profileUserId = fallbackGuestProfile.id;
      }
    }
    saveRuntimeConfig(nextConfig);
    automaticConfigBackup.settingsChanged({
      createImmediately: normalizeAutomaticBackupSettings(nextConfig.automaticBackup).enabled,
    });

    res.json({
      ok: true,
      restartRequired: true,
      importedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error importing config:", err);
    res.status(500).json({ error: err.message || "Failed to import configuration" });
  }
});
Object.assign(ns.adminSettings, {
  resolveAdminConnectUrl,
});
