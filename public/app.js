const state = {
  self: null,
  settings: null,
  peers: [],
  conversations: [],
  activePeerId: null,
  messagesByPeer: new Map(),
  pendingShare: null,
  selectedFile: null,
  dragDepth: 0,
  runtimeBaseUrl: "",
  pollTimer: null
};

const els = {
  selfName: document.querySelector("#self-name"),
  selfId: document.querySelector("#self-id"),
  settingsOpen: document.querySelector("#settings-open"),
  settingsModal: document.querySelector("#settings-modal"),
  settingsClose: document.querySelector("#settings-close"),
  connectForm: document.querySelector("#connect-form"),
  connectInput: document.querySelector("#connect-input"),
  storageForm: document.querySelector("#storage-form"),
  serverBaseInput: document.querySelector("#server-base-input"),
  storageInput: document.querySelector("#storage-input"),
  deviceList: document.querySelector("#device-list"),
  emptyState: document.querySelector("#empty-state"),
  chatView: document.querySelector("#chat-view"),
  chatTitle: document.querySelector("#chat-title"),
  chatSubtitle: document.querySelector("#chat-subtitle"),
  mobileBack: document.querySelector("#mobile-back"),
  fileHint: document.querySelector("#file-hint"),
  dropzone: document.querySelector("#dropzone"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  shareDraft: document.querySelector("#share-draft"),
  messageInput: document.querySelector("#message-input"),
  fileInput: document.querySelector("#file-input"),
  filePicker: document.querySelector(".file-picker"),
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

function isMobileViewport() {
  return window.matchMedia("(max-width: 840px)").matches;
}

function isCapacitorRuntime() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

function getDefaultRuntimeBaseUrl() {
  if (isCapacitorRuntime()) {
    return window.localStorage.getItem("hmdchat.runtimeBaseUrl") || "http://127.0.0.1:33445";
  }
  return "";
}

function apiUrl(pathname) {
  if (!state.runtimeBaseUrl) {
    return pathname;
  }
  return `${state.runtimeBaseUrl}${pathname}`;
}

function fileUrl(messageId) {
  return apiUrl(`/api/files/${encodeURIComponent(messageId)}`);
}

function websocketUrl() {
  if (!state.runtimeBaseUrl) {
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  }

  const runtimeUrl = new URL(state.runtimeBaseUrl);
  const wsProtocol = runtimeUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${runtimeUrl.host}`;
}

function getChatFromUrl() {
  return new URLSearchParams(window.location.search).get("chat");
}

function setChatInUrl(peerId) {
  const url = new URL(window.location.href);
  if (peerId) {
    url.searchParams.set("chat", peerId);
  } else {
    url.searchParams.delete("chat");
  }
  history.pushState({ chat: peerId || null }, "", url);
}

function syncMobileLayout() {
  document.body.classList.toggle(
    "mobile-chat-open",
    isMobileViewport() && Boolean(state.activePeerId)
  );
}

async function syncChatFromUrl() {
  const peerId = getChatFromUrl();
  if (!peerId) {
    state.activePeerId = null;
    syncMobileLayout();
    renderSidebar();
    renderChatShell();
    return;
  }

  const known = state.conversations.some((item) => item.peerId === peerId);
  if (known) {
    await selectPeer(peerId, { updateUrl: false });
    return;
  }

  state.activePeerId = null;
  syncMobileLayout();
  renderSidebar();
  renderChatShell();
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
  const response = await fetch(apiUrl(url), options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with ${response.status}`);
  }
  return response.json();
}

async function loadState() {
  state.runtimeBaseUrl = getDefaultRuntimeBaseUrl();
  const payload = await fetchJson("/api/state");
  state.self = payload.self;
  state.settings = payload.settings;
  state.peers = payload.peers;
  state.conversations = payload.conversations;
  state.pendingShare = payload.pendingShare || null;
  renderSelf();
  renderSettings();
  renderSidebar();
  renderPendingShare();
  await syncChatFromUrl();
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

function renderSettings() {
  els.serverBaseInput.value = state.runtimeBaseUrl || "";
  els.storageInput.value = state.settings?.receivedFilesDir || "";
  els.storageInput.closest(".storage-fieldset")?.classList.toggle("hidden", isCapacitorRuntime());
}

function renderPendingShare() {
  if (!els.shareDraft) {
    return;
  }

  const pending = state.pendingShare;
  if (!pending) {
    els.shareDraft.classList.add("hidden");
    els.shareDraft.innerHTML = "";
    return;
  }

  const summary = pending.type === "file"
    ? `${escapeHtml(pending.file?.originalName || "Shared file")}${
        pending.file?.size ? ` • ${formatFileSize(pending.file.size)}` : ""
      }`
    : escapeHtml(pending.text || "Shared text");

  const caption = pending.type === "file" && pending.text
    ? `<div class="share-draft-caption">${escapeHtml(pending.text)}</div>`
    : "";

  els.shareDraft.innerHTML = `
    <div class="share-draft-body">
      <div class="share-draft-label">Shared from Android</div>
      <div class="share-draft-title">${summary}</div>
      ${caption}
    </div>
    <div class="share-draft-actions">
      <button type="button" class="share-send-btn">Send</button>
      <button type="button" class="share-clear-btn">Dismiss</button>
    </div>
  `;
  els.shareDraft.classList.remove("hidden");

  els.shareDraft.querySelector(".share-send-btn")?.addEventListener("click", async () => {
    const peer = activePeer();
    if (!peer) {
      window.alert("Select a chat first.");
      return;
    }

    try {
      const payload = await fetchJson("/api/share/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ peerId: peer.id })
      });
      state.pendingShare = null;
      rememberMessage(payload.message);
      upsertConversationFromMessage(payload.message);
      renderPendingShare();
      renderSidebar();
      renderMessages();
    } catch (error) {
      window.alert(error.message);
    }
  });

  els.shareDraft.querySelector(".share-clear-btn")?.addEventListener("click", async () => {
    try {
      await fetchJson("/api/share/clear", { method: "POST" });
      state.pendingShare = null;
      renderPendingShare();
    } catch (error) {
      window.alert(error.message);
    }
  });
}

function openSettings() {
  els.settingsModal.classList.remove("hidden");
  els.settingsModal.setAttribute("aria-hidden", "false");
}

function closeSettings() {
  els.settingsModal.classList.add("hidden");
  els.settingsModal.setAttribute("aria-hidden", "true");
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

async function selectPeer(peerId, options = { updateUrl: true }) {
  state.activePeerId = peerId;
  syncMobileLayout();
  if (options.updateUrl) {
    setChatInUrl(peerId);
  }
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

function clearActivePeer() {
  state.activePeerId = null;
  setChatInUrl(null);
  syncMobileLayout();
  renderSidebar();
  renderChatShell();
}

function renderChatShell() {
  const peer = activePeer();
  els.emptyState.classList.toggle("hidden", !!peer);
  els.chatView.classList.toggle("hidden", !peer);
  els.fileHint.classList.toggle("hidden", !peer || isCapacitorRuntime());
  els.mobileBack?.classList.toggle("hidden", !isMobileViewport());
  syncMobileLayout();

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
      const href = fileUrl(message.id);
      const fileCard = document.createElement("div");
      fileCard.className = "file-card";
      const incomingActions = isCapacitorRuntime()
        ? `
            <div class="file-actions">
              <button type="button" class="open-btn">Open</button>
            </div>
          `
        : `
            <div class="file-actions">
              <button type="button" class="save-as-btn primary">Save as</button>
              <button type="button" class="open-btn">Open</button>
            </div>
          `;
      const actionsHtml =
        message.direction === "incoming"
          ? incomingActions
          : message.deliveredAt
            ? `
              <div class="file-actions">
                <button type="button" class="open-btn">Open</button>
              </div>
            `
            : `
              <div class="file-actions">
                <button type="button" class="cancel-btn danger">Cancel</button>
              </div>
            `;

      fileCard.innerHTML = `
        <div class="file-card-header">
          <a href="${href}" target="_blank" rel="noreferrer">${escapeHtml(message.file.originalName)}</a>
          <span class="muted">${escapeHtml(message.direction === "incoming" ? "received" : "sent")}</span>
        </div>
        ${actionsHtml}
      `;

      const openBtn = fileCard.querySelector(".open-btn");
      if (openBtn) {
        openBtn.addEventListener("click", () => {
          window.open(href, "_blank", "noreferrer");
        });
      }

      const saveAsBtn = fileCard.querySelector(".save-as-btn");
      if (saveAsBtn) {
        saveAsBtn.addEventListener("click", async () => {
          const destinationPath = window.prompt(
            "Move file to path or folder",
            message.file.originalName
          );
          if (!destinationPath) {
            return;
          }

          try {
            await fetchJson(`/api/files/${encodeURIComponent(message.id)}/move`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ destinationPath })
            });
            renderMessages();
          } catch (error) {
            window.alert(error.message);
          }
        });
      }

      const cancelBtn = fileCard.querySelector(".cancel-btn");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", async () => {
          try {
            await fetchJson(`/api/files/${encodeURIComponent(message.id)}/cancel`, {
              method: "POST"
            });
            const list = state.messagesByPeer.get(message.peerId) || [];
            state.messagesByPeer.set(
              message.peerId,
              list.filter((item) => item.id !== message.id)
            );
            renderMessages();
            renderSidebar();
          } catch (error) {
            window.alert(error.message);
          }
        });
      }

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
  formData.append("originalName", file.name || "upload.bin");
  formData.append("mimeType", file.type || "application/octet-stream");
  formData.append("size", String(file.size || 0));

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

function bindStorageForm() {
  els.storageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const runtimeBaseUrl = els.serverBaseInput.value.trim();
    const receivedFilesDir = els.storageInput.value.trim();
    if (runtimeBaseUrl) {
      window.localStorage.setItem("hmdchat.runtimeBaseUrl", runtimeBaseUrl.replace(/\/$/, ""));
      state.runtimeBaseUrl = runtimeBaseUrl.replace(/\/$/, "");
      await loadState();
      connectSocket();
    }

    if (!receivedFilesDir || isCapacitorRuntime()) {
      return;
    }

    try {
      const payload = await fetchJson("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receivedFilesDir })
      });
      state.settings = payload.settings;
      renderSettings();
    } catch (error) {
      window.alert(error.message);
    }
  });
}

function bindDragAndDrop() {
  const hasFiles = (event) => {
    const types = event.dataTransfer?.types;
    return Array.from(types || []).includes("Files");
  };

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

  document.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    state.dragDepth += 1;
    activate();
  });

  document.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) {
      deactivate();
    }
  });

  document.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    if (activePeer()) {
      els.dropzone.classList.remove("hidden");
    }
  });

  document.addEventListener("drop", async (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (!event.dataTransfer?.files?.length) {
      deactivate();
      return;
    }

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
  if (isCapacitorRuntime()) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
    }

    state.pollTimer = window.setInterval(async () => {
      try {
        const payload = await fetchJson("/api/state");
        state.self = payload.self;
        state.settings = payload.settings;
        state.peers = payload.peers;
        state.conversations = payload.conversations;
        state.pendingShare = payload.pendingShare || null;
        if (state.activePeerId) {
          await loadMessages(state.activePeerId);
        }
        renderSelf();
        renderSettings();
        renderSidebar();
        renderChatShell();
        renderPendingShare();
      } catch (_error) {
      }
    }, 2500);
    return;
  }

  const socket = new WebSocket(websocketUrl());

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "state") {
      state.self = data.payload.self;
      state.settings = data.payload.settings;
      state.peers = data.payload.peers;
      state.conversations = data.payload.conversations;
      state.pendingShare = data.payload.pendingShare || null;
      renderSelf();
      renderSettings();
      renderSidebar();
      renderChatShell();
      renderPendingShare();
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
els.mobileBack?.addEventListener("click", clearActivePeer);
els.settingsOpen.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsModal.addEventListener("click", (event) => {
  if (event.target?.matches("[data-close-modal]")) {
    closeSettings();
  }
});
bindConnectForm();
bindStorageForm();
bindDragAndDrop();
window.addEventListener("popstate", async () => {
  await syncChatFromUrl();
});
window.addEventListener("resize", syncMobileLayout);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSettings();
  }
});
await loadState();
syncMobileLayout();
connectSocket();
