/* ==========================================================================
   AgentVox Dashboard - WebSocket Client & UI
   ========================================================================== */

const state = {
  queue: [],
  history: [],
  speaking: null,
  muted: [],
  globalMute: false,
  omniActive: false,
  sources: new Set(),
  projects: new Set(),
  connected: false,
};

let ws;
let reconnectTimer;
const RECONNECT_DELAY = 2000;

// --- WebSocket Connection ---

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    state.connected = true;
    clearTimeout(reconnectTimer);
    renderConnectionStatus();
  };

  ws.onclose = () => {
    state.connected = false;
    renderConnectionStatus();
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  };

  ws.onerror = () => {
    state.connected = false;
    renderConnectionStatus();
  };

  ws.onmessage = (event) => {
    const { event: evt, data } = JSON.parse(event.data);
    handleEvent(evt, data);
  };
}

function handleEvent(evt, data) {
  switch (evt) {
    case "init":
      state.queue = data.queue || [];
      state.history = data.history || [];
      state.muted = data.muted || [];
      state.globalMute = data.globalMute || false;
      state.omniActive = data.omniActive || false;
      // Collect known sources and projects
      state.history.forEach((m) => {
        if (m.source) state.sources.add(m.source);
        if (m.project && m.project !== "unknown") state.projects.add(m.project);
      });
      renderAll();
      break;

    case "message:new":
      if (data.source) state.sources.add(data.source);
      if (data.project && data.project !== "unknown") state.projects.add(data.project);
      state.queue.push(data);
      renderQueue();
      renderSources();
      break;

    case "speaking:start":
      state.speaking = data;
      // Remove from queue if present
      state.queue = state.queue.filter((m) => m.sessionId !== data.sessionId);
      renderSpeaking();
      renderQueue();
      break;

    case "speaking:done":
      state.speaking = null;
      state.history.push(data);
      if (data.source) state.sources.add(data.source);
      if (data.project && data.project !== "unknown") state.projects.add(data.project);
      renderSpeaking();
      renderHistory();
      renderSources();
      break;

    case "mute:update":
      state.muted = data.muted || [];
      state.globalMute = data.globalMute || false;
      renderMuteButton();
      renderSources();
      break;

    case "omni:update":
      state.omniActive = data.active || false;
      renderOmniButton();
      break;
  }
}

// --- Render Functions ---

function renderAll() {
  renderConnectionStatus();
  renderSpeaking();
  renderQueue();
  renderHistory();
  renderSources();
  renderMuteButton();
  renderOmniButton();
}

function renderConnectionStatus() {
  const el = document.getElementById("connection-status");
  const textEl = el.querySelector(".connection-text");
  if (state.connected) {
    el.className = "connection-indicator connected";
    el.title = "WebSocket connected";
    textEl.textContent = "Connected";
  } else {
    el.className = "connection-indicator disconnected";
    el.title = "WebSocket disconnected - reconnecting...";
    textEl.textContent = "Disconnected";
  }
}

function renderSpeaking() {
  const section = document.getElementById("now-speaking");
  if (!state.speaking) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");

  // Apply source-specific styling
  section.className = "panel panel-speaking";
  const src = state.speaking.source || "";
  if (src === "codex") section.classList.add("source-codex");
  else if (src === "omni") section.classList.add("source-omni");

  const sourceEl = document.getElementById("speaking-source");
  sourceEl.textContent = src;
  sourceEl.className = "source-badge " + badgeClass(src);

  document.getElementById("speaking-project").textContent = state.speaking.project || "";

  const branchEl = document.getElementById("speaking-branch");
  branchEl.textContent = state.speaking.branch ? "on " + state.speaking.branch : "";

  const textEl = document.getElementById("speaking-text");
  textEl.textContent = state.speaking.spokenText || state.speaking.context || "";
}

function renderQueue() {
  const list = document.getElementById("queue-list");
  const countEl = document.getElementById("queue-count");
  const count = state.queue.length;
  countEl.textContent = count;
  countEl.className = "badge-count" + (count > 0 ? " has-items" : "");

  if (count === 0) {
    list.innerHTML = '<div class="empty-state">No pending messages</div>';
    return;
  }

  list.innerHTML = state.queue
    .map((m) => {
      const priority = m.priority || "normal";
      return `
        <div class="message-card">
          <span class="priority-indicator ${esc(priority)}"></span>
          <div class="meta">
            <span class="source-badge ${badgeClass(m.source)}">${esc(m.source)}</span>
          </div>
          <div class="content">
            <span class="project-name">${esc(m.project || "")}</span>
            ${m.branch ? `<span class="branch-name">on ${esc(m.branch)}</span>` : ""}
            <div class="text">${esc(truncate(m.context || m.summary || "", 100))}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderHistory() {
  const list = document.getElementById("history-list");
  const recent = state.history.slice(-30).reverse();

  if (recent.length === 0) {
    list.innerHTML = '<div class="empty-state">No messages yet</div>';
    return;
  }

  list.innerHTML = recent
    .map((m) => {
      const time = m.receivedAt
        ? new Date(m.receivedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      return `
        <div class="message-card">
          <span class="time">${esc(time)}</span>
          <div class="meta">
            <span class="source-badge ${badgeClass(m.source)}">${esc(m.source || "")}</span>
          </div>
          <div class="content">
            <span class="project-name">${esc(m.project || "")}</span>
            ${m.branch ? `<span class="branch-name">on ${esc(m.branch)}</span>` : ""}
            <div class="text">${esc(truncate(m.spokenText || m.context || "", 120))}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderSources() {
  const list = document.getElementById("sources-list");

  // Combine sources and projects into mute targets
  const allSources = [...state.sources];
  const allProjects = [...state.projects];

  if (allSources.length === 0 && allProjects.length === 0) {
    list.innerHTML = '<div class="empty-state">No sources connected</div>';
    return;
  }

  let html = "";

  // Source mute controls
  for (const s of allSources) {
    const isMuted = state.muted.includes(s);
    const messageCount = state.history.filter((m) => m.source === s).length;
    html += `
      <div class="source-control">
        <div class="source-control-left">
          <span class="source-badge ${badgeClass(s)}">${esc(s)}</span>
          <span class="source-count">${messageCount} msg${messageCount !== 1 ? "s" : ""}</span>
        </div>
        <button class="btn btn-sm ${isMuted ? "active" : ""}" onclick="toggleMute('${esc(s)}')">
          ${isMuted ? "Unmute" : "Mute"}
        </button>
      </div>
    `;
  }

  // Project mute controls
  for (const p of allProjects) {
    const isMuted = state.muted.includes(p);
    const messageCount = state.history.filter((m) => m.project === p).length;
    html += `
      <div class="source-control">
        <div class="source-control-left">
          <span class="project-name">${esc(p)}</span>
          <span class="source-count">${messageCount} msg${messageCount !== 1 ? "s" : ""}</span>
        </div>
        <button class="btn btn-sm ${isMuted ? "active" : ""}" onclick="toggleMute('${esc(p)}')">
          ${isMuted ? "Unmute" : "Mute"}
        </button>
      </div>
    `;
  }

  list.innerHTML = html;
}

function renderMuteButton() {
  const btn = document.getElementById("mute-all");
  if (state.globalMute) {
    btn.innerHTML = '<span class="mute-icon">&#9834;</span> Unmute All';
    btn.className = "btn btn-mute active";
  } else {
    btn.innerHTML = '<span class="mute-icon">&#9834;</span> Mute All';
    btn.className = "btn btn-mute";
  }
}

function renderOmniButton() {
  const btn = document.getElementById("omni-toggle");
  if (state.omniActive) {
    btn.innerHTML = '<span class="omni-icon">&#9678;</span> Omni On';
    btn.className = "btn btn-omni active";
  } else {
    btn.innerHTML = '<span class="omni-icon">&#9678;</span> Omni';
    btn.className = "btn btn-omni";
  }
}

// --- User Actions ---

document.getElementById("mute-all").addEventListener("click", () => {
  const endpoint = state.globalMute ? "/api/unmute" : "/api/mute";
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: "all" }),
  });
});

document.getElementById("omni-toggle").addEventListener("click", () => {
  const endpoint = state.omniActive ? "/api/omni/off" : "/api/omni/on";
  fetch(endpoint, { method: "POST" });
});

function toggleMute(target) {
  const isMuted = state.muted.includes(target);
  const endpoint = isMuted ? "/api/unmute" : "/api/mute";
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
}

// --- Helpers ---

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function badgeClass(source) {
  if (!source) return "custom";
  if (source === "claude-code") return "claude-code";
  if (source === "codex") return "codex";
  if (source === "omni") return "omni";
  return "custom";
}

function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Initialize ---

connect();
