import fsp from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";
import { WebSocketServer } from "ws";
import { Bonjour } from "bonjour-service";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.DATA_DIR || path.join(rootDir, ".data");
const uploadsDir = path.join(dataDir, "uploads");
const settingsFile = path.join(dataDir, "settings.json");
const dbFile = path.join(dataDir, "messages.json");
const publicDir = path.join(rootDir, "public");

await fsp.mkdir(uploadsDir, { recursive: true });

const port = Number(process.env.PORT || 33445);
const deviceName = process.env.DEVICE_NAME || os.hostname();
const serviceInstanceName = process.env.SERVICE_INSTANCE_NAME || `${deviceName}-${port}`;
const seedPeers = (process.env.SEED_PEERS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const app = express();
const localAddresses = getLocalIpCandidates();
const defaultSettings = {
  deviceId: process.env.DEVICE_ID || null,
  deviceName,
  receivedFilesDir: path.resolve(process.env.RECEIVED_FILES_DIR || path.join(dataDir, "received"))
};

await fsp.mkdir(defaultSettings.receivedFilesDir, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(publicDir));

const state = {
  self: {
    id: "",
    name: "",
    port,
    addresses: ["127.0.0.1", ...localAddresses]
  },
  settings: await loadSettings(),
  peers: new Map(),
  messages: await loadMessages()
};

state.self.id = state.settings.deviceId;
state.self.name = state.settings.deviceName || deviceName;

await ensureReceivedFilesDir();

const upload = multer({ dest: uploadsDir });

function nowIso() {
  return new Date().toISOString();
}

function cleanHost(host) {
  if (!host) {
    return host;
  }
  if (host.startsWith("::ffff:")) {
    return host.slice(7);
  }
  if (host === "::1") {
    return "127.0.0.1";
  }
  return host;
}

function getLocalIpCandidates() {
  let interfaces;

  try {
    interfaces = os.networkInterfaces();
  } catch (_error) {
    return [];
  }

  const addresses = [];

  for (const group of Object.values(interfaces)) {
    for (const info of group || []) {
      if (!info || info.internal || info.family !== "IPv4") {
        continue;
      }
      addresses.push(info.address);
    }
  }

  return [...new Set(addresses)];
}

function getPreferredAddress() {
  return localAddresses[0] || "127.0.0.1";
}

async function loadMessages() {
  try {
    const raw = await fsp.readFile(dbFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function loadSettings() {
  try {
    const raw = await fsp.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw);
    const merged = {
      ...defaultSettings,
      deviceId: parsed.deviceId || defaultSettings.deviceId || createDeviceId(),
      deviceName: parsed.deviceName || defaultSettings.deviceName,
      ...parsed,
      receivedFilesDir: parsed.receivedFilesDir || defaultSettings.receivedFilesDir
    };
    if (!parsed.deviceId) {
      await saveSettings(merged);
    }
    return merged;
  } catch (error) {
    if (error.code === "ENOENT") {
      const created = {
        ...defaultSettings,
        deviceId: defaultSettings.deviceId || createDeviceId()
      };
      await saveSettings(created);
      return created;
    }
    throw error;
  }
}

let writeQueue = Promise.resolve();

function saveMessages() {
  writeQueue = writeQueue.then(() =>
    fsp.writeFile(dbFile, JSON.stringify(state.messages, null, 2), "utf8")
  );
  return writeQueue;
}

function saveSettings(settings) {
  return fsp.writeFile(settingsFile, JSON.stringify(settings, null, 2), "utf8");
}

function createDeviceId() {
  return `${os.hostname()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function ensureReceivedFilesDir() {
  await fsp.mkdir(state.settings.receivedFilesDir, { recursive: true });
}

function parseIncomingFile(req, res) {
  return new Promise((resolve, reject) => {
    multer({ dest: state.settings.receivedFilesDir }).single("file")(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function filePathForMessage(message) {
  return message?.file?.path || null;
}

function serializeMessage(message) {
  return message;
}

function serializePeer(peer) {
  return {
    id: peer.id,
    name: peer.name,
    host: peer.host,
    port: peer.port,
    online: peer.online,
    lastSeenAt: peer.lastSeenAt,
    source: peer.source || "mdns"
  };
}

function serializePeers() {
  return [...state.peers.values()].sort((a, b) => a.name.localeCompare(b.name)).map(serializePeer);
}

function getConversationMessages(peerId) {
  return state.messages
    .filter((message) => message.peerId === peerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function getConversations() {
  const conversations = new Map();

  for (const message of state.messages) {
    const current = conversations.get(message.peerId) || {
      peerId: message.peerId,
      lastMessage: null,
      unreadCount: 0
    };

    if (!current.lastMessage || current.lastMessage.createdAt < message.createdAt) {
      current.lastMessage = message;
    }

    if (message.direction === "incoming" && !message.readAt) {
      current.unreadCount += 1;
    }

    conversations.set(message.peerId, current);
  }

  return [...conversations.values()].sort((a, b) => {
    const aDate = a.lastMessage?.createdAt || "";
    const bDate = b.lastMessage?.createdAt || "";
    return bDate.localeCompare(aDate);
  });
}

function broadcast(type, payload) {
  const body = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(body);
    }
  }
}

function broadcastState() {
  broadcast("state", {
    self: state.self,
    settings: state.settings,
    peers: serializePeers(),
    conversations: getConversations()
  });
}

async function addMessage(message) {
  state.messages.push(message);
  await saveMessages();
  broadcast("message", message);
  broadcastState();
}

function resolvePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer || !peer.online) {
    return null;
  }
  return peer;
}

function upsertPeer(peerInput) {
  if (!peerInput.id || peerInput.id === state.self.id) {
    return null;
  }

  const existing = state.peers.get(peerInput.id) || {
    id: peerInput.id,
    name: peerInput.name || peerInput.id,
    host: peerInput.host,
    port: peerInput.port,
    online: true,
    lastSeenAt: nowIso(),
    source: peerInput.source || "manual"
  };

  existing.name = peerInput.name || existing.name;
  existing.host = cleanHost(peerInput.host || existing.host);
  existing.port = Number(peerInput.port || existing.port || 0);
  existing.online = peerInput.online ?? true;
  existing.lastSeenAt = peerInput.lastSeenAt || nowIso();
  existing.source = peerInput.source || existing.source || "manual";

  state.peers.set(existing.id, existing);
  return existing;
}

async function markOutgoingDelivered(messageId, deliveredAt) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) {
    return null;
  }

  message.deliveredAt = deliveredAt || nowIso();
  await saveMessages();
  broadcast("message", message);
  broadcastState();
  return message;
}

async function markOutgoingRead(messageIds, readAt) {
  const touched = [];

  for (const messageId of messageIds) {
    const message = state.messages.find((item) => item.id === messageId);
    if (!message) {
      continue;
    }
    message.readAt = readAt;
    touched.push(message);
  }

  if (!touched.length) {
    return;
  }

  await saveMessages();
  for (const message of touched) {
    broadcast("message", message);
  }
  broadcastState();
}

async function sendJson(peer, route, payload) {
  const response = await fetch(`http://${peer.host}:${peer.port}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json().catch(() => ({}));
}

async function sendFileToPeer(peer, localFile) {
  const fileBuffer = await fsp.readFile(localFile.path);
  const formData = new FormData();

  formData.append("file", new Blob([fileBuffer], { type: localFile.mimeType }), localFile.originalName);
  formData.append("senderId", state.self.id);
  formData.append("senderName", state.self.name);
  formData.append("senderPort", String(state.self.port));
  formData.append("messageId", localFile.id);
  formData.append("caption", localFile.text || "");
  formData.append("createdAt", localFile.createdAt);

  const response = await fetch(`http://${peer.host}:${peer.port}/api/inbox/file`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error(`File upload failed with ${response.status}`);
  }

  return response.json().catch(() => ({}));
}

async function registerPeerFromHello(host, hello, source = "manual") {
  if (!hello?.self?.id || hello.self.id === state.self.id) {
    return null;
  }

  const peer = upsertPeer({
    id: hello.self.id,
    name: hello.self.name,
    host: cleanHost(host),
    port: hello.self.port,
    online: true,
    lastSeenAt: nowIso(),
    source
  });

  broadcastState();
  return peer;
}

async function connectPeerByAddress(address) {
  const raw = String(address || "").trim();
  if (!raw) {
    throw new Error("Address is required.");
  }

  let host = raw;
  let targetPort = port;

  if (raw.includes(":")) {
    const lastColon = raw.lastIndexOf(":");
    host = raw.slice(0, lastColon).trim();
    targetPort = Number(raw.slice(lastColon + 1).trim());
  }

  if (!host || !targetPort) {
    throw new Error("Address must look like host:port.");
  }

  const response = await fetch(`http://${cleanHost(host)}:${targetPort}/api/hello`);
  if (!response.ok) {
    throw new Error(`Unable to connect to ${raw}.`);
  }

  const hello = await response.json();
  return registerPeerFromHello(cleanHost(host), hello, "manual");
}

async function sendReadReceipt(peerId, messageIds) {
  const peer = resolvePeer(peerId);
  if (!peer || !messageIds.length) {
    return;
  }

  try {
    await sendJson(peer, "/api/receipts/read", {
      readerId: state.self.id,
      readerName: state.self.name,
      messageIds,
      readAt: nowIso()
    });
  } catch (_error) {
  }
}

app.get("/api/hello", async (_req, res) => {
  res.json({
    self: state.self
  });
});

app.get("/api/state", async (_req, res) => {
  res.json({
    self: state.self,
    settings: state.settings,
    peers: serializePeers(),
    conversations: getConversations()
  });
});

app.get("/api/messages/:peerId", async (req, res) => {
  res.json({
    peerId: req.params.peerId,
    messages: getConversationMessages(req.params.peerId)
  });
});

app.get("/api/settings", async (_req, res) => {
  res.json(state.settings);
});

app.put("/api/settings", async (req, res) => {
  const receivedFilesDir = String(req.body.receivedFilesDir || "").trim();
  if (!receivedFilesDir) {
    res.status(400).json({ error: "receivedFilesDir is required." });
    return;
  }

  const nextSettings = {
    ...state.settings,
    receivedFilesDir: path.resolve(receivedFilesDir)
  };

  await fsp.mkdir(nextSettings.receivedFilesDir, { recursive: true });
  await saveSettings(nextSettings);
  state.settings = nextSettings;

  res.json({ ok: true, settings: state.settings });
});

app.post("/api/peers/connect", async (req, res) => {
  try {
    const peer = await connectPeerByAddress(req.body.address);
    if (!peer) {
      res.status(400).json({ error: "Target resolved to this device." });
      return;
    }
    res.json({ ok: true, peer: serializePeer(peer) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/conversations/:peerId/read", async (req, res) => {
  const peerId = req.params.peerId;
  const receiptIds = [];

  for (const message of state.messages) {
    if (message.peerId === peerId && message.direction === "incoming" && !message.readAt) {
      message.readAt = nowIso();
      receiptIds.push(message.id);
    }
  }

  if (receiptIds.length) {
    await saveMessages();
    for (const message of getConversationMessages(peerId)) {
      if (receiptIds.includes(message.id)) {
        broadcast("message", message);
      }
    }
    broadcastState();
    await sendReadReceipt(peerId, receiptIds);
  }

  res.json({ ok: true, messageIds: receiptIds });
});

app.post("/api/send/text", async (req, res) => {
  const { peerId, text } = req.body;
  const peer = resolvePeer(peerId);

  if (!peer) {
    res.status(404).json({ error: "Peer is offline or unknown." });
    return;
  }

  const message = {
    id: crypto.randomUUID(),
    peerId,
    peerName: peer.name,
    direction: "outgoing",
    kind: "text",
    text: String(text || "").trim(),
    createdAt: nowIso(),
    deliveredAt: null,
    readAt: null,
    file: null
  };

  if (!message.text) {
    res.status(400).json({ error: "Text is required." });
    return;
  }

  await addMessage(message);

  try {
    const response = await sendJson(peer, "/api/inbox/text", {
      messageId: message.id,
      senderId: state.self.id,
      senderName: state.self.name,
      senderPort: state.self.port,
      text: message.text,
      createdAt: message.createdAt
    });
    await markOutgoingDelivered(message.id, response.deliveredAt || nowIso());
    res.json({ ok: true, message });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/send/file", upload.single("file"), async (req, res) => {
  const peerId = req.body.peerId;
  const caption = String(req.body.caption || "").trim();
  const peer = resolvePeer(peerId);

  if (!peer) {
    res.status(404).json({ error: "Peer is offline or unknown." });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "File is required." });
    return;
  }

  const safeName = sanitizeFilename(req.file.originalname || "upload.bin");
  const finalPath = path.join(uploadsDir, `${Date.now()}-${safeName}`);
  await fsp.rename(req.file.path, finalPath);

  const message = {
    id: crypto.randomUUID(),
    peerId,
    peerName: peer.name,
    direction: "outgoing",
    kind: "file",
    text: caption,
    createdAt: nowIso(),
    deliveredAt: null,
    readAt: null,
    file: {
      originalName: req.file.originalname,
      storedName: path.basename(finalPath),
      path: finalPath,
      size: req.file.size,
      mimeType: req.file.mimetype
    }
  };

  await addMessage(message);

  try {
    const response = await sendFileToPeer(peer, {
      id: message.id,
      originalName: req.file.originalname,
      path: finalPath,
      mimeType: req.file.mimetype,
      text: caption,
      createdAt: message.createdAt
    });
    await markOutgoingDelivered(message.id, response.deliveredAt || nowIso());
    res.json({ ok: true, message });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/inbox/text", async (req, res) => {
  const senderId = String(req.body.senderId || "");
  const senderName = String(req.body.senderName || senderId);
  upsertPeer({
    id: senderId,
    name: senderName,
    host: cleanHost(req.ip),
    port: Number(req.body.senderPort || 0),
    online: true,
    lastSeenAt: nowIso(),
    source: "incoming"
  });

  const deliveredAt = nowIso();
  const message = {
    id: String(req.body.messageId || crypto.randomUUID()),
    peerId: senderId,
    peerName: senderName,
    direction: "incoming",
    kind: "text",
    text: String(req.body.text || ""),
    createdAt: String(req.body.createdAt || nowIso()),
    deliveredAt,
    readAt: null,
    file: null
  };

  await addMessage(message);
  res.json({ ok: true, deliveredAt });
});

app.post("/api/inbox/file", async (req, res) => {
  try {
    await parseIncomingFile(req, res);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "File is required." });
    return;
  }

  const senderId = String(req.body.senderId || "");
  const senderName = String(req.body.senderName || senderId);
  const safeName = sanitizeFilename(req.file.originalname || "received.bin");
  const finalPath = path.join(state.settings.receivedFilesDir, `${Date.now()}-${safeName}`);
  await fsp.rename(req.file.path, finalPath);

  upsertPeer({
    id: senderId,
    name: senderName,
    host: cleanHost(req.ip),
    port: Number(req.body.senderPort || 0),
    online: true,
    lastSeenAt: nowIso(),
    source: "incoming"
  });

  const deliveredAt = nowIso();
  const message = {
    id: String(req.body.messageId || crypto.randomUUID()),
    peerId: senderId,
    peerName: senderName,
    direction: "incoming",
    kind: "file",
    text: String(req.body.caption || ""),
    createdAt: String(req.body.createdAt || nowIso()),
    deliveredAt,
    readAt: null,
    file: {
      originalName: req.file.originalname,
      storedName: path.basename(finalPath),
      path: finalPath,
      size: req.file.size,
      mimeType: req.file.mimetype
    }
  };

  await addMessage(message);
  res.json({ ok: true, deliveredAt });
});

app.get("/api/files/:messageId", async (req, res) => {
  const message = state.messages.find((item) => item.id === req.params.messageId);
  if (!message?.file?.path) {
    res.status(404).json({ error: "File not found." });
    return;
  }

  res.download(message.file.path, message.file.originalName || path.basename(message.file.path));
});

app.post("/api/files/:messageId/move", async (req, res) => {
  const message = state.messages.find((item) => item.id === req.params.messageId);
  if (!message?.file?.path) {
    res.status(404).json({ error: "File not found." });
    return;
  }

  const targetInput = String(req.body.destinationPath || "").trim();
  if (!targetInput) {
    res.status(400).json({ error: "destinationPath is required." });
    return;
  }

  const currentPath = message.file.path;
  const resolvedTarget = path.resolve(targetInput);
  let finalTarget = resolvedTarget;

  try {
    const stat = await fsp.stat(resolvedTarget);
    if (stat.isDirectory()) {
      finalTarget = path.join(resolvedTarget, message.file.originalName || path.basename(currentPath));
    }
  } catch (_error) {
  }

  if (path.resolve(currentPath) === path.resolve(finalTarget)) {
    res.json({ ok: true, file: message.file });
    return;
  }

  await fsp.mkdir(path.dirname(finalTarget), { recursive: true });
  await fsp.rename(currentPath, finalTarget);

  message.file.path = finalTarget;
  message.file.storedName = path.basename(finalTarget);
  await saveMessages();

  broadcast("message", message);
  broadcastState();

  res.json({
    ok: true,
    file: message.file
  });
});

app.post("/api/receipts/read", async (req, res) => {
  const messageIds = Array.isArray(req.body.messageIds) ? req.body.messageIds : [];
  const readAt = String(req.body.readAt || nowIso());
  await markOutgoingRead(messageIds, readAt);
  res.json({ ok: true });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`hmdchat listening on http://0.0.0.0:${port}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "state",
      payload: {
        self: state.self,
        settings: state.settings,
        peers: serializePeers(),
        conversations: getConversations()
      }
    })
  );
});

const bonjour = new Bonjour();

bonjour.publish({
  name: serviceInstanceName,
  type: "hmdchat",
  protocol: "tcp",
  port,
  host: getPreferredAddress(),
  txt: {
    id: state.self.id,
    name: state.self.name,
    addresses: JSON.stringify(state.self.addresses)
  }
});

const browser = bonjour.find({ type: "hmdchat", protocol: "tcp" }, (service) => {
  const peerId = service.txt?.id;
  if (!peerId || peerId === state.self.id) {
    return;
  }

  const addresses = service.addresses?.filter((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address)) || [];
  const host = cleanHost(addresses[0] || service.referer?.address || service.host);

  upsertPeer({
    id: peerId,
    name: service.txt?.name || service.name || peerId,
    host,
    port: service.port,
    online: true,
    lastSeenAt: nowIso(),
    source: "mdns"
  });

  broadcastState();
});

browser.on("down", (service) => {
  const peerId = service.txt?.id;
  if (!peerId || !state.peers.has(peerId)) {
    return;
  }

  const peer = state.peers.get(peerId);
  peer.online = false;
  peer.lastSeenAt = nowIso();
  state.peers.set(peerId, peer);
  broadcastState();
});

async function warmManualPeers() {
  for (const address of seedPeers) {
    try {
      await connectPeerByAddress(address);
    } catch (_error) {
    }
  }
}

setTimeout(() => {
  warmManualPeers();
}, 400);

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  const forceExit = setTimeout(() => {
    process.exit(0);
  }, 2000);
  forceExit.unref();

  try {
    for (const client of wss.clients) {
      client.terminate();
    }

    browser.stop();

    await new Promise((resolve) => {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        resolve();
      });
    });

    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  } finally {
    clearTimeout(forceExit);
    process.exit(0);
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
