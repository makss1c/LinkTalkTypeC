/**
 * LinkTalk server — реестр мостов и их runtime-конфиг
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const crypto = require("crypto");
const { getBridgeEndpointsForDevice, getBridgePortAudioLevels, getFeedBridgeEndpointsForDevice, getBridgeTargetsForUser } = require("../dbHandler");
const ns = require("../ns");
const { BRIDGE_REGISTRY_STALE_MS, bridgeControlSessions, bridgeRegistry } = ns.base;
const { canBridgeAuthAccessBridge } = ns.companionAuth;

function requireBridgeControlSession(req, res, next) {
  const session = bridgeControlSessions.get(String(req.params.sessionId || ""));
  if (!session || session.closed) {
    return res.status(404).json({ error: "Bridge session not found" });
  }
  if (!canBridgeAuthAccessBridge(req.bridgeApiAuth, session.bridgeId)) {
    return res.status(403).json({ error: "Bridge session requires global API key access or this bridge token" });
  }
  session.lastSeenAt = Date.now();
  req.bridgeSession = session;
  req.bridgePeer = ns.bridgeControl.peers.get(session.id) || null;
  if (!req.bridgePeer) {
    ns.bridgeControl.closeBridgeControlSession(session.id, "bridge-peer-missing");
    return res.status(410).json({ error: "Bridge peer is no longer available" });
  }
  next();
}

function normalizeBridgeRegistryText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 200) : fallback;
}

function normalizeBridgeRegistryChannel(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 512) return null;
  return number;
}

function sanitizeBridgeChannelPairs(pairs = []) {
  if (!Array.isArray(pairs)) return [];
  const result = [];
  for (const pair of pairs.slice(0, 1024)) {
    const left = normalizeBridgeRegistryChannel(pair?.left_channel ?? pair?.leftChannel);
    const right = normalizeBridgeRegistryChannel(pair?.right_channel ?? pair?.rightChannel);
    if (left === null || right === null || (right !== left && right !== left + 1)) continue;
    result.push({
      label: normalizeBridgeRegistryText(pair?.label, right === left ? `${left}` : `${left}/${right}`),
      left_channel: left,
      right_channel: right,
    });
  }
  return result;
}

function buildBridgeChannelOptions(maxChannels, pairs = []) {
  const normalizedMaxChannels = Number(maxChannels);
  const result = [];
  const seen = new Set();
  const addOption = (left, right, label = null) => {
    if (!Number.isInteger(left) || !Number.isInteger(right) || left < 1 || right < 1) return;
    const key = `${left}:${right}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      label: normalizeBridgeRegistryText(label, left === right ? `${left}` : `${left}/${right}`),
      left_channel: left,
      right_channel: right,
    });
  };

  for (const pair of pairs) {
    addOption(pair.left_channel, pair.right_channel, pair.label);
  }

  if (Number.isInteger(normalizedMaxChannels) && normalizedMaxChannels > 0) {
    for (let channel = 1; channel <= normalizedMaxChannels; channel += 1) {
      addOption(channel, channel);
    }
    for (let left = 1; left < normalizedMaxChannels; left += 2) {
      addOption(left, left + 1);
    }
  }

  return result;
}

function sanitizeBridgeInventory(inventory = {}) {
  const devices = Array.isArray(inventory.devices) ? inventory.devices : [];
  return {
    host: normalizeBridgeRegistryText(inventory.host, "unknown"),
    devices: devices.slice(0, 256).map((device, index) => {
      const direction = device?.direction === "output" ? "output" : "input";
      const id = normalizeBridgeRegistryText(device?.id, `${direction}-${index}`);
      const name = normalizeBridgeRegistryText(device?.name, id);
      const maxChannels = normalizeBridgeRegistryChannel(device?.max_channels ?? device?.maxChannels) || 0;
      const channelPairs = sanitizeBridgeChannelPairs(device?.channel_pairs ?? device?.channelPairs);
      return {
        id,
        name,
        direction,
        is_default: Boolean(device?.is_default ?? device?.isDefault),
        max_channels: maxChannels,
        supports_48k: Boolean(device?.supports_48k ?? device?.supports48k),
        channel_pairs: buildBridgeChannelOptions(maxChannels, channelPairs),
      };
    }),
  };
}

function normalizeBridgeId(value) {
  const normalized = normalizeBridgeRegistryText(value);
  if (!normalized) return crypto.randomUUID();
  return normalized.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 120) || crypto.randomUUID();
}

function serializeBridgeRegistryEntry(entry, now = Date.now()) {
  return {
    id: entry.id,
    name: entry.name,
    platform: entry.platform || "unknown",
    host: entry.inventory.host,
    inventory: entry.inventory,
    connectedAt: entry.firstSeenAtIso || entry.lastSeenAtIso,
    lastSeenAt: entry.lastSeenAtIso,
    remoteAddress: entry.remoteAddress || null,
    stale: now - entry.lastSeenAtMs > BRIDGE_REGISTRY_STALE_MS,
  };
}

function getBridgeRegistrySnapshot() {
  const now = Date.now();
  return [...bridgeRegistry.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }))
    .map((entry) => serializeBridgeRegistryEntry(entry, now));
}

function buildBridgeRuntimeConfig(bridgeId) {
  const normalizedBridgeId = normalizeBridgeId(bridgeId);
  const serializeTriggerTargets = (userId) => getBridgeTargetsForUser(userId)
    .map((target) => ({
      type: target.targetType,
      id: Number(target.targetId),
      name: target.name || `${target.targetType} ${target.targetId}`,
    }));
  const userPorts = getBridgeEndpointsForDevice(normalizedBridgeId).map((row) => {
    return {
      id: `user-${row.user_id}`,
      kind: "user",
      userId: Number(row.user_id),
      feedId: null,
      label: row.user_name || `User ${row.user_id}`,
      audioLevels: getBridgePortAudioLevels('user', row.user_id),
      enabled: true,
      input: {
        deviceId: row.input_device,
        leftChannel: Number(row.input_left_channel),
        rightChannel: Number(row.input_right_channel),
      },
      output: {
        deviceId: row.output_device,
        leftChannel: Number(row.output_left_channel),
        rightChannel: Number(row.output_right_channel),
      },
      trigger: {
        mode: row.trigger_mode === "audio-level" ? "audio-level" : "external",
        target: row.trigger_target_type && row.trigger_target_id
          ? {
              type: row.trigger_target_type,
              id: Number(row.trigger_target_id),
            }
          : null,
        thresholdDb: Number.isFinite(Number(row.trigger_threshold_db))
          ? Number(row.trigger_threshold_db)
          : -45,
      },
      triggerTargets: serializeTriggerTargets(row.user_id),
      updatedAt: row.updated_at || null,
    };
  });
  const feedPorts = getFeedBridgeEndpointsForDevice(normalizedBridgeId).map((row) => {
    return {
      id: `feed-${row.feed_id}`,
      kind: "feed",
      userId: null,
      feedId: Number(row.feed_id),
      label: row.feed_name || `Feed ${row.feed_id}`,
      audioLevels: getBridgePortAudioLevels('feed', row.feed_id),
      enabled: true,
      input: {
        deviceId: row.input_device,
        leftChannel: Number(row.input_left_channel),
        rightChannel: Number(row.input_right_channel),
      },
      output: null,
      updatedAt: row.updated_at || null,
    };
  });
  const ports = [...userPorts, ...feedPorts];
  const signature = JSON.stringify(ports);
  return {
    bridgeId: normalizedBridgeId,
    revision: crypto.createHash("sha256").update(signature).digest("hex").slice(0, 16),
    ports,
  };
}

function allowBridgeCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization,x-api-key,content-type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}
Object.assign(ns.bridgeRegistry, {
  allowBridgeCors,
  buildBridgeRuntimeConfig,
  getBridgeRegistrySnapshot,
  normalizeBridgeId,
  normalizeBridgeRegistryText,
  requireBridgeControlSession,
  sanitizeBridgeInventory,
  serializeBridgeRegistryEntry,
});
