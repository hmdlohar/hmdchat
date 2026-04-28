const state = {
  self: null,
  peers: [],
  conversations: [],
  activePeerId: null,
  messagesByPeer: new Map(),
  selectedFile: null,
  dragDepth: 0
};

const els = {
  selfName: document.querySelector("#self-name"),
  selfId: document.querySelector("#self-id"),
  connectForm: document.querySelector("#connect-form"),
  connectInput: document.querySelector("#connect-input"),
  deviceList: document.querySelector("#device-list"),
  emptyState: document.querySelector("#empty-state"),
  chatView: document.querySelector("#chat-view"),
  chatTitle: document.querySelector("#chat-title"),
  chatSubtitle: document.querySelector("#chat-subtitle"),
  fileHint: document.querySelector("#file-hint"),
  dropzone: document.querySelector("#dropzone"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  messageInput: document.querySelector("#message-input"),
  fileInput: document.querySelector("#file-input"),
  selectedFile: document.querySelector("#selected-file"),
  deviceItemTemplate: document.querySelector("#device-item-template")
};

function formatTime(value) {
  return new Date(value).toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  });
}

function formatFileSize(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function activePeer() {
  return state.peers.find((peer) => peer.id === state.activePeerId) || null;
}

function rememberMessage(message) {
  const list = state.messagesByPeer.get(message.peerId) || [];
  const index = list.findIndex((item) => item.id === message.id);

  if (index === -1) {
    list.push(message);
  } else {
    list[index] = message;
  }

  list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  state.messagesByPeer.set(message.peerId, list);
}

function setSelectedFile(file) {
  state.selectedFile = file || null;
  els.fileInput.value = "";

  if (!state.selectedFile) {
    els.selectedFile.textContent = "";
    els.selectedFile.classList.add("hidden");
    return;
  }

  els.selectedFile.textContent = `${state.selectedFile.name} • ${formatFileSize(state.selectedFile.size)}`;
  els.selectedFile.classList.remove("hidden");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with ${response.status}`);
  }
  return response.json();
}

async function loadState() {
  const payload = await fetchJson("/api/state");
  state.self = payload.self;
  state.peers = payload.peers;
  state.conversations = payload.conversations;
  renderSelf();
  renderSidebar();
}

async function loadMessages(peerId) {
  const payload = await fetchJson(`/api/messages/${encodeURIComponent(peerId)}`);
  state.messagesByPeer.set(peerId, payload.messages);
  if (state.activePeerId === peerId) {
    renderMessages();
  }
}

function upsertConversationFromMessage(message) {
  const existing = state.conversations.find((item) => item.peerId === message.peerId);
  if (existing) {
    existing.lastMessage = message;
    if (message.direction === "incoming" && !message.readAt) {
      existing.unreadCount += 1;
    }
  } else {
    state.conversations.unshift({
      peerId: message.peerId,
      lastMessage: message,
      unreadCount: message.direction === "incoming" && !message.readAt ? 1 : 0
    });
  }

  state.conversations.sort((a, b) =>
    (b.lastMessage?.createdAt || "").localeCompare(a.lastMessage?.createdAt || "")
  );
}

function renderSelf() {
  els.selfName.textContent = state.self?.name || "This device";
  els.selfId.textContent = state.self?.id || "";
}

function renderSidebar() {
  const peersById = new Map(state.peers.map((peer) => [peer.id, peer]));
  const conversationIds = new Set(state.conversations.map((item) => item.peerId));

  for (const peer of state.peers) {
    if (!conversationIds.has(peer.id)) {
      state.conversations.push({
        peerId: peer.id,
        lastMessage: null,
        unreadCount: 0
      });
    }
  }

  const items = [...state.conversations].sort((a, b) => {
    const aDate = a.lastMessage?.createdAt || "";
    const bDate = b.lastMessage?.createdAt || "";
    if (aDate !== bDate) {
      return bDate.localeCompare(aDate);
    }
    const aName = peersById.get(a.peerId)?.name || a.peerId;
    const bName = peersById.get(b.peerId)?.name || b.peerId;
    return aName.localeCompare(bName);
  });

  els.deviceList.innerHTML = "";

  for (const item of items) {
    const peer = peersById.get(item.peerId) || {
      id: item.peerId,
      name: item.peerId,
      online: false
    };
    const node = els.deviceItemTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle("active", state.activePeerId === peer.id);
    node.querySelector(".device-name").textContent = peer.name;
    node.querySelector(".status-dot").classList.toggle("online", !!peer.online);

    let preview = peer.online ? "Online" : "Offline";
    if (item.lastMessage?.kind === "file") {
      preview = item.lastMessage.text ? `File: ${item.lastMessage.text}` : "File";
    } else if (item.lastMessage?.text) {
      preview = item.lastMessage.text;
    }
    node.querySelector(".device-preview").textContent = preview;

    const badge = node.querySelector(".badge");
    badge.textContent = item.unreadCount;
    badge.classList.toggle("hidden", !item.unreadCount);

    node.addEventListener("click", () => selectPeer(peer.id));
    els.deviceList.appendChild(node);
  }
}

async function selectPeer(peerId) {
  state.activePeerId = peerId;
  renderSidebar();
  renderChatShell();

  if (!state.messagesByPeer.has(peerId)) {
    await loadMessages(peerId);
  } else {
    renderMessages();
  }

  await fetchJson(`/api/conversations/${encodeURIComponent(peerId)}/read`, { method: "POST" });
  const conversation = state.conversations.find((item) => item.peerId === peerId);
  if (conversation) {
    conversation.unreadCount = 0;
  }

  const messages = state.messagesByPeer.get(peerId) || [];
  for (const message of messages) {
    if (message.direction === "incoming") {
      message.readAt ||= new Date().toISOString();
    }
  }

  renderSidebar();
  renderMessages();
}

function renderChatShell() {
  const peer = activePeer();
  els.emptyState.classList.toggle("hidden", !!peer);
  els.chatView.classList.toggle("hidden", !peer);
  els.fileHint.classList.toggle("hidden", !peer);

  if (!peer) {
    return;
  }

  els.chatTitle.textContent = peer.name;
  els.chatSubtitle.textContent = peer.online
    ? `${peer.host}:${peer.port} • ${peer.source || "mdns"}`
    : `Offline. Last seen ${peer.lastSeenAt ? formatTime(peer.lastSeenAt) : "unknown"}`;
}

function renderMessages() {
  const peer = activePeer();
  if (!peer) {
    return;
  }

  const messages = state.messagesByPeer.get(peer.id) || [];
  els.messages.innerHTML = "";

  for (const message of messages) {
    const item = document.createElement("article");
    item.className = `message ${message.direction}`;

    const body = document.createElement("div");
    if (message.text) {
      body.innerHTML = `<div>${escapeHtml(message.text)}</div>`;
    }

    if (message.kind === "file" && message.file) {
      const href = `/uploads/${encodeURIComponent(message.file.storedName)}`;
      const fileCard = document.createElement("div");
      fileCard.className = "file-card";
      fileCard.innerHTML = `<a href="${href}" target="_blank" rel="noreferrer">${escapeHtml(message.file.originalName)}</a>`;
      body.appendChild(fileCard);
    }

    const meta = document.createElement("div");
    meta.className = "meta";
    const status =
      message.direction === "outgoing"
        ? message.readAt
          ? " • read"
          : message.deliveredAt
            ? " • delivered"
            : " • sending"
        : "";
    meta.textContent = `${formatTime(message.createdAt)}${status}`;

    item.append(body, meta);
    els.messages.appendChild(item);
  }

  els.messages.scrollTop = els.messages.scrollHeight;
}

async function sendText(peerId, text) {
  const payload = await fetchJson("/api/send/text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peerId, text })
  });

  rememberMessage(payload.message);
  upsertConversationFromMessage(payload.message);
  renderSidebar();
  renderMessages();
}

async function sendFile(peerId, file, caption) {
  const formData = new FormData();
  formData.append("peerId", peerId);
  formData.append("caption", caption || "");
  formData.append("file", file);

  const payload = await fetchJson("/api/send/file", {
    method: "POST",
    body: formData
  });

  rememberMessage(payload.message);
  upsertConversationFromMessage(payload.message);
  renderSidebar();
  renderMessages();
}

async function sendCurrentFile(peerId, caption) {
  if (!state.selectedFile) {
    return false;
  }
  await sendFile(peerId, state.selectedFile, caption);
  setSelectedFile(null);
  return true;
}

async function connectPeer(address) {
  const payload = await fetchJson("/api/peers/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address })
  });

  state.peers = state.peers.filter((peer) => peer.id !== payload.peer.id).concat(payload.peer);
  renderSidebar();
}

function bindComposer() {
  els.fileInput.addEventListener("change", () => {
    setSelectedFile(els.fileInput.files?.[0] || null);
  });

  els.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const peer = activePeer();
    if (!peer) {
      return;
    }

    const text = els.messageInput.value.trim();

    try {
      if (state.selectedFile) {
        await sendCurrentFile(peer.id, text);
      } else if (text) {
        await sendText(peer.id, text);
      } else {
        return;
      }

      els.messageInput.value = "";
      setSelectedFile(null);
    } catch (error) {
      window.alert(error.message);
    }
  });
}

function bindConnectForm() {
  els.connectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const address = els.connectInput.value.trim();
    if (!address) {
      return;
    }

    try {
      await connectPeer(address);
      els.connectInput.value = "";
    } catch (error) {
      window.alert(error.message);
    }
  });
}

function bindDragAndDrop() {
  const activate = () => {
    if (!activePeer()) {
      return;
    }
    els.dropzone.classList.remove("hidden");
  };

  const deactivate = () => {
    state.dragDepth = 0;
    els.dropzone.classList.add("hidden");
  };

  window.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) {
      return;
    }
    state.dragDepth += 1;
    activate();
  });

  window.addEventListener("dragleave", () => {
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      deactivate();
    }
  });

  window.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("Files")) {
      return;
    }
    event.preventDefault();
  });

  window.addEventListener("drop", async (event) => {
    if (!event.dataTransfer?.files?.length) {
      return;
    }

    event.preventDefault();
    deactivate();

    const peer = activePeer();
    if (!peer) {
      window.alert("Select a device before dropping files.");
      return;
    }

    const file = event.dataTransfer.files[0];
    const caption = els.messageInput.value.trim();

    try {
      setSelectedFile(file);
      await sendCurrentFile(peer.id, caption);
      els.messageInput.value = "";
    } catch (error) {
      window.alert(error.message);
    }
  });
}

function connectSocket() {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "state") {
      state.self = data.payload.self;
      state.peers = data.payload.peers;
      state.conversations = data.payload.conversations;
      renderSelf();
      renderSidebar();
      renderChatShell();
      return;
    }

    if (data.type === "message") {
      const message = data.payload;
      rememberMessage(message);
      upsertConversationFromMessage(message);

      if (state.activePeerId === message.peerId) {
        renderMessages();
      }

      renderSidebar();
    }
  });

  socket.addEventListener("close", () => {
    setTimeout(connectSocket, 1500);
  });
}

bindComposer();
bindConnectForm();
bindDragAndDrop();
await loadState();
connectSocket();
