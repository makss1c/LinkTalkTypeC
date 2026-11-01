/**
 * LinkTalk server — сетевые утилиты, mDNS-ответчик, редирект на HTTPS
 * Автоматически выделено из монолитного serverCore.js; порядок загрузки сохранён.
 */

const os = require("os");
const dgram = require("dgram");
const { isRunningInContainer } = require("../runtimeEnvironment");
const { selectMdnsAddresses } = require("../mediaNetwork");
const http = require("http");
const ns = require("../ns");
const { getActiveRtcAddresses, resolveTransportAnnouncedAddress } = ns.config;
const { HTTPS_PORT, HTTP_PORT, httpPortSource, mdnsHostname } = ns.listenConfig;

function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (!net || net.internal) continue;
      if (net.family === "IPv4") {
        addresses.push(net.address);
      }
    }
  }

  if (addresses.length === 0) {
    addresses.push("127.0.0.1");
  }

  return addresses;
}

function getStartupHosts() {
  const configuredPublicIp = typeof process.env.PUBLIC_IP === "string"
    ? process.env.PUBLIC_IP.trim()
    : "";

  if (configuredPublicIp) {
    return [configuredPublicIp];
  }

  const preferredTransportAddress = resolveTransportAnnouncedAddress();
  if (preferredTransportAddress.mode === "interface" && preferredTransportAddress.announcedAddress) {
    return getActiveRtcAddresses(preferredTransportAddress);
  }

  if (isRunningInContainer()) {
    return [];
  }

  return Array.from(new Set(getLocalIPv4Addresses()));
}

function encodeDnsName(name) {
  const labels = name.split(".").filter(Boolean);
  const parts = [];

  for (const label of labels) {
    const buf = Buffer.from(label, "utf8");
    const len = Buffer.alloc(1);
    len[0] = buf.length;
    parts.push(len, buf);
  }

  parts.push(Buffer.from([0x00]));
  return Buffer.concat(parts);
}

function decodeDnsName(buffer, offset, depth = 0) {
  if (depth > 10 || offset >= buffer.length) {
    return null;
  }

  const labels = [];
  let idx = offset;

  while (idx < buffer.length) {
    const len = buffer[idx];

    if (len === 0) {
      idx += 1;
      return { name: labels.join("."), nextOffset: idx };
    }

    if ((len & 0xc0) === 0xc0) {
      if (idx + 1 >= buffer.length) {
        return null;
      }

      const pointer = ((len & 0x3f) << 8) | buffer[idx + 1];
      const result = decodeDnsName(buffer, pointer, depth + 1);
      if (!result) {
        return null;
      }

      const pointerLabels = result.name ? result.name.split(".") : [];
      const combined = labels.concat(pointerLabels.filter(Boolean));
      return { name: combined.join("."), nextOffset: idx + 2 };
    }

    const end = idx + 1 + len;
    if (end > buffer.length) {
      return null;
    }

    labels.push(buffer.toString("utf8", idx + 1, end));
    idx = end;
  }

  return null;
}

function startMdnsResponder(hostname) {
  const mediaRoute = resolveTransportAnnouncedAddress();
  const addresses = selectMdnsAddresses(mediaRoute, getLocalIPv4Addresses());
  if (mediaRoute.mode === "interface" && !addresses.length) {
    throw new Error("Selected media adapters have no usable IPv4 address; mDNS announcement disabled");
  }
  const multicastInterfaces = mediaRoute.mode === "interface" ? addresses : [undefined];
  const sockets = multicastInterfaces.map(address => createMdnsResponder(hostname, address));
  return { close() { sockets.forEach(socket => socket.close()); } };
}

function createMdnsResponder(hostname, multicastInterface) {
  const questionName = hostname.toLowerCase();
  const getAdvertisedAddresses = () => selectMdnsAddresses(
    resolveTransportAnnouncedAddress(), getLocalIPv4Addresses()
  );
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const CLASS_IN = 0x0001;
  const TYPE_A = 0x0001;
  const TYPE_ANY = 0x00ff;

  socket.on("error", (err) => {
    console.warn(`[mDNS] ${err.message}`);
    try {
      socket.close();
    } catch (closeErr) {
      console.warn(`[mDNS] Failed to close socket: ${closeErr.message}`);
    }
  });

  socket.on("message", (message, rinfo) => {
    if (message.length < 12) {
      return;
    }

    const flags = message.readUInt16BE(2);
    const isQuery = (flags & 0x8000) === 0;
    if (!isQuery) {
      return;
    }

    const qdCount = message.readUInt16BE(4);
    if (!qdCount) {
      return;
    }

    let offset = 12;
    for (let i = 0; i < qdCount; i += 1) {
      const decoded = decodeDnsName(message, offset);
      if (!decoded) {
        return;
      }

      const { name, nextOffset } = decoded;
      offset = nextOffset;

      if (offset + 4 > message.length) {
        return;
      }

      const type = message.readUInt16BE(offset);
      offset += 2;
      const qclass = message.readUInt16BE(offset);
      offset += 2;

      const normalizedName = name.toLowerCase().replace(/\.$/, "");
      if (normalizedName !== questionName) {
        continue;
      }

      if (type !== TYPE_A && type !== TYPE_ANY) {
        continue;
      }

      const addresses = getAdvertisedAddresses();
      if (!addresses.length) {
        return;
      }

      const wantsUnicast = (qclass & 0x8000) !== 0;
      const nameBuf = encodeDnsName(questionName);

      const header = Buffer.alloc(12);
      header.writeUInt16BE(0x0000, 0); // ID must be 0 for mDNS
      header.writeUInt16BE(0x8400, 2); // standard response, authoritative
      header.writeUInt16BE(1, 4); // one question echoed back
      header.writeUInt16BE(addresses.length, 6); // number of answers
      header.writeUInt16BE(0, 8); // no NS records
      header.writeUInt16BE(0, 10); // no additional records

      const question = Buffer.alloc(nameBuf.length + 4);
      nameBuf.copy(question);
      question.writeUInt16BE(type, nameBuf.length);
      question.writeUInt16BE(qclass & 0x7fff, nameBuf.length + 2);

      const answers = [];
      for (const address of addresses) {
        const octets = address.split(".").map((part) => Number(part));
        if (octets.length !== 4 || octets.some((num) => Number.isNaN(num))) {
          continue;
        }

        const data = Buffer.from(octets);
        const answer = Buffer.alloc(nameBuf.length + 10 + data.length);
        nameBuf.copy(answer);
        let idx = nameBuf.length;
        answer.writeUInt16BE(TYPE_A, idx);
        idx += 2;
        answer.writeUInt16BE(CLASS_IN | 0x8000, idx); // cache flush bit + IN
        idx += 2;
        answer.writeUInt32BE(120, idx); // TTL 120 seconds
        idx += 4;
        answer.writeUInt16BE(data.length, idx);
        idx += 2;
        data.copy(answer, idx);
        answers.push(answer);
      }

      if (!answers.length) {
        return;
      }

      const response = Buffer.concat([header, question, ...answers]);
      const targetPort = wantsUnicast ? rinfo.port : 5353;
      const targetAddress = wantsUnicast ? rinfo.address : "224.0.0.251";

      socket.send(response, targetPort, targetAddress, (err) => {
        if (err) {
          console.warn(`[mDNS] Failed to send response: ${err.message}`);
        }
      });

      break;
    }
  });

  socket.bind({ address: "0.0.0.0", port: 5353, exclusive: false }, () => {
    try {
      socket.addMembership("224.0.0.251", multicastInterface);
      if (multicastInterface) socket.setMulticastInterface(multicastInterface);
    } catch (err) {
      console.warn(`[mDNS] Unable to join multicast group: ${err.message}`);
    }
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(true);
    console.log(`[mDNS] Advertising ${questionName} on ${getAdvertisedAddresses().join(", ")}`);
  });

  return socket;
}

function getHttpsRedirectHost(req) {
  const rawHost = String(req.headers.host || "").trim();
  const bracketedIpv6 = rawHost.match(/^(\[[0-9a-f:.]+\])(?::\d+)?$/i);
  if (bracketedIpv6) return bracketedIpv6[1];
  const hostname = rawHost.match(/^([a-z0-9.-]+)(?::\d+)?$/i);
  return hostname?.[1] || mdnsHostname || "localhost";
}

function redirectToHttps(req, res) {
  const host = getHttpsRedirectHost(req);
  res.writeHead(301, {
    Connection: "close",
    Location: `https://${host}:${HTTPS_PORT}${req.url}`,
  });
  res.end();
}

// Optional dedicated HTTP → HTTPS redirect server
if (HTTP_PORT !== null) {
  const redirectServer = http.createServer(redirectToHttps);

  redirectServer.listen(HTTP_PORT, () => {
    const sourceLabel = httpPortSource === "auto" ? "(auto for mDNS)" : "";
    console.log(`HTTP redirect server running on port ${HTTP_PORT} ${sourceLabel}`.trim());
  });

  redirectServer.on("error", (err) => {
    if (err.code === "EACCES") {
      console.warn(`Failed to start HTTP redirect server on ${HTTP_PORT}: ${err.message}. Run with elevated privileges or set HTTP_PORT to a high port.`);
    } else {
      console.warn(`Failed to start HTTP redirect server on ${HTTP_PORT}: ${err.message}`);
    }
  });
}
Object.assign(ns.networkUtils, {
  getLocalIPv4Addresses,
  getStartupHosts,
  startMdnsResponder,
});
