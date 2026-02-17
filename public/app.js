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
  voices: { default: "jean", sources: {}, projects: {} },
  speed: { default: 1.0, sources: {}, projects: {} },
  personality: { default: { verbosity: 2, vibe: "chill", humor: 25 }, sources: {}, projects: {} },
  availableVoices: [],
  availableVibes: ["neutral", "chill", "hyped", "zen", "snarky"],
  queueExpanded: false,
  sourceNames: {},
  editingSource: null,
};

function displayName(source) {
  return state.sourceNames[source] || source;
}

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
      state.voices = data.voices || { default: "jean", sources: {}, projects: {} };
      state.speed = data.speed || { default: 1.0, sources: {}, projects: {} };
      state.availableVoices = data.availableVoices || [];
      state.personality = data.personality || state.personality;
      state.availableVibes = data.availableVibes || state.availableVibes;
      state.sourceNames = data.sourceNames || {};
      // Collect known sources and projects
      state.history.forEach((m) => {
        if (m.source) state.sources.add(m.source);
        if (m.project && m.project !== "unknown") state.projects.add(m.project);
      });
      renderAll();
      // Fetch latest personality from REST API to ensure we have persisted values
      fetchPersonality();
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

    case "voices:update":
      state.voices = { default: data.default || "jean", sources: data.sources || {}, projects: data.projects || {} };
      renderSources();
      break;

    case "speed:update":
      state.speed = { default: data.default || 1.0, sources: data.sources || {}, projects: data.projects || {} };
      renderSources();
      break;

    case "personality:update":
      state.personality = { default: data.default || { verbosity: 2, vibe: "chill", humor: 25 }, sources: data.sources || {}, projects: data.projects || {} };
      renderSources();
      break;

    case "queue:cleared":
      state.queue = [];
      renderQueue();
      break;

    case "history:cleared":
      state.history = state.history.filter(
        (m) => m.source !== data.target && m.project !== data.target
      );
      renderHistory();
      renderSources();
      break;

    case "sources:rename":
      state.sourceNames = data.sourceNames || {};
      renderAll();
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
  sourceEl.textContent = displayName(src);
  sourceEl.className = "source-badge " + badgeClass(src);

  document.getElementById("speaking-project").textContent = state.speaking.project || "";

  const branchEl = document.getElementById("speaking-branch");
  branchEl.textContent = state.speaking.branch ? "on " + state.speaking.branch : "";

  const textEl = document.getElementById("speaking-text");
  textEl.textContent = state.speaking.spokenText || state.speaking.context || "";
}

function renderQueue() {
  const bar = document.getElementById("queue-bar");
  const countEl = document.getElementById("queue-count");
  const itemsEl = document.getElementById("queue-items");
  const caretEl = document.getElementById("queue-caret");
  const count = state.queue.length;

  if (count === 0) {
    bar.classList.add("hidden");
    state.queueExpanded = false;
    return;
  }

  bar.classList.remove("hidden");
  countEl.textContent = count;
  caretEl.innerHTML = state.queueExpanded ? "&#9662;" : "&#9656;";

  if (state.queueExpanded) {
    itemsEl.classList.add("expanded");
    itemsEl.innerHTML = state.queue
      .map((m) => {
        const priority = m.priority || "normal";
        return `
          <div class="message-card">
            <span class="priority-indicator ${esc(priority)}"></span>
            <div class="meta">
              <span class="source-badge ${badgeClass(m.source)}">${esc(displayName(m.source))}</span>
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
  } else {
    itemsEl.classList.remove("expanded");
    itemsEl.innerHTML = "";
  }
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
            <span class="source-badge ${badgeClass(m.source)}">${esc(displayName(m.source || ""))}</span>
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

  // Default settings bar — distinct elevated bar, no Mute/Clear
  const defaultSpeed = state.speed.default || 1.0;
  const defaultVoiceHtml = `<select class="vibe-select" onchange="changeVoice('default', '', this.value)" title="Default voice">
    ${state.availableVoices.map(v => `<option value="${esc(v)}"${(state.voices.default || 'jean') === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
  </select>`;
  html += `
    <div class="source-control-group default-settings">
      <div class="source-row source-row-primary">
        <span class="default-label">DEFAULT</span>
      </div>
      ${renderPersonalityRow('default', '', { voiceHtml: defaultVoiceHtml, speedVal: defaultSpeed, speedType: 'default', speedName: '' })}
    </div>
  `;

  // Source cards — two-row dense layout
  for (const s of allSources) {
    const isMuted = state.muted.includes(s);
    const messageCount = state.history.filter((m) => m.source === s).length;
    const sourceVoice = (state.voices.sources && state.voices.sources[s]) || "";
    const sourceSpeed = (state.speed.sources && state.speed.sources[s]) || "";
    const sourceSpeedVal = sourceSpeed || defaultSpeed;
    const sourceVoiceHtml = `<select class="vibe-select" onchange="changeVoice('source', '${esc(s)}', this.value)" title="Voice for ${esc(s)}">
      <option value=""${!sourceVoice ? ' selected' : ''}>default (${esc(state.voices.default || 'jean')})</option>
      ${state.availableVoices.map(v => `<option value="${esc(v)}"${sourceVoice === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
    </select>`;
    const isEditing = state.editingSource === s;
    const announceChecked = (state.personality.sources && state.personality.sources[s] && state.personality.sources[s].announceSource) || false;
    html += `
      <div class="source-control-group source-group">
        <div class="source-row source-row-primary">
          ${isEditing
            ? `<input class="source-rename-input" id="rename-input-${esc(s)}" value="${esc(displayName(s))}" onkeydown="handleRenameKey(event, '${esc(s)}')" onblur="handleRenameBlur(event, '${esc(s)}')" />`
            : `<span class="source-badge ${badgeClass(s)}" onclick="startRename('${esc(s)}')" style="cursor:pointer">${esc(displayName(s))}</span><button class="source-edit-btn" onclick="startRename('${esc(s)}')" title="Rename source">&#9998;</button>`
          }
          <span class="source-count">${messageCount} msg${messageCount !== 1 ? "s" : ""}</span>
          <label class="announce-toggle" title="Announce source name before speaking">
            <input type="checkbox" ${announceChecked ? "checked" : ""} onchange="toggleAnnounce('${esc(s)}', this.checked, 'source')" />
            Announce
          </label>
          <div class="source-actions">
            <button class="btn btn-sm ${isMuted ? "active" : ""}" onclick="toggleMute('${esc(s)}')">
              ${isMuted ? "Unmute" : "Mute"}
            </button>
            <button class="btn btn-sm btn-clear-source" onclick="clearSource('${esc(s)}')" title="Clear messages from ${esc(s)}">Clear</button>
          </div>
        </div>
        ${renderPersonalityRow('source', s, { voiceHtml: sourceVoiceHtml, speedVal: sourceSpeedVal, speedType: 'source', speedName: s })}
      </div>
    `;
  }

  // Project cards — same two-row dense layout as source cards
  for (const p of allProjects) {
    const isMuted = state.muted.includes(p);
    const messageCount = state.history.filter((m) => m.project === p).length;
    const projectVoice = (state.voices.projects && state.voices.projects[p]) || "";
    const projectSpeed = (state.speed.projects && state.speed.projects[p]) || "";
    const projectSpeedVal = projectSpeed || defaultSpeed;
    const projectVoiceHtml = `<select class="vibe-select" onchange="changeVoice('project', '${esc(p)}', this.value)" title="Voice for ${esc(p)}">
      <option value=""${!projectVoice ? ' selected' : ''}>default (${esc(state.voices.default || 'jean')})</option>
      ${state.availableVoices.map(v => `<option value="${esc(v)}"${projectVoice === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
    </select>`;
    const isEditingProject = state.editingSource === p;
    const announceProjectChecked = (state.personality.projects && state.personality.projects[p] && state.personality.projects[p].announceSource) || false;
    html += `
      <div class="source-control-group source-group">
        <div class="source-row source-row-primary">
          ${isEditingProject
            ? `<input class="source-rename-input" id="rename-input-${esc(p)}" value="${esc(displayName(p))}" onkeydown="handleRenameKey(event, '${esc(p)}')" onblur="handleRenameBlur(event, '${esc(p)}')" />`
            : `<span class="project-name project-name-editable" onclick="startRename('${esc(p)}')">${esc(displayName(p))}</span><button class="source-edit-btn" onclick="startRename('${esc(p)}')" title="Rename project">&#9998;</button>`
          }
          <span class="source-count">${messageCount} msg${messageCount !== 1 ? "s" : ""}</span>
          <label class="announce-toggle" title="Announce project name before speaking">
            <input type="checkbox" ${announceProjectChecked ? "checked" : ""} onchange="toggleAnnounce('${esc(p)}', this.checked, 'project')" />
            Announce
          </label>
          <div class="source-actions">
            <button class="btn btn-sm ${isMuted ? "active" : ""}" onclick="toggleMute('${esc(p)}')">
              ${isMuted ? "Unmute" : "Mute"}
            </button>
            <button class="btn btn-sm btn-clear-source" onclick="clearSource('${esc(p)}')" title="Clear messages from ${esc(p)}">Clear</button>
          </div>
        </div>
        ${renderPersonalityRow('project', p, { voiceHtml: projectVoiceHtml, speedVal: projectSpeedVal, speedType: 'project', speedName: p })}
      </div>
    `;
  }

  list.innerHTML = html;

  // Auto-focus rename input if editing
  if (state.editingSource) {
    const input = document.getElementById('rename-input-' + state.editingSource);
    if (input) {
      // Size input to content
      input.style.width = Math.max(120, Math.min(300, input.value.length * 8 + 20)) + 'px';
      input.focus();
      input.select();
    }
  }
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

function toggleGlobalMute() {
  const endpoint = state.globalMute ? "/api/unmute" : "/api/mute";
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: "all" }),
  });
}

function toggleMute(target) {
  const isMuted = state.muted.includes(target);
  const endpoint = isMuted ? "/api/unmute" : "/api/mute";
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
}

function changeVoice(type, name, voice) {
  fetch("/api/voices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, name, voice: voice || null }),
  });
  // Preview the selected voice
  const previewVoice = voice || state.voices.default || "jean";
  fetch("/api/tts/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice: previewVoice }),
  });
}

function changeSpeed(type, name, speed) {
  fetch("/api/speed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, name, speed: parseFloat(speed) }),
  });
}

function changePersonality(type, name, field, value) {
  const patch = {};
  if (field === "verbosity") patch.verbosity = parseInt(value);
  else if (field === "vibe") patch.vibe = value;
  else if (field === "humor") patch.humor = parseInt(value);

  // Optimistic local update so the state persists even before the broadcast arrives
  if (type === "default") {
    state.personality.default = { ...(state.personality.default || {}), ...patch };
  } else if (type === "source") {
    if (!state.personality.sources) state.personality.sources = {};
    state.personality.sources[name] = { ...(state.personality.sources[name] || {}), ...patch };
  } else if (type === "project") {
    if (!state.personality.projects) state.personality.projects = {};
    state.personality.projects[name] = { ...(state.personality.projects[name] || {}), ...patch };
  }

  fetch("/api/personality", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, name, personality: patch }),
  }).catch((err) => console.error("Failed to save personality:", err));
}

function getPersonality(type, name) {
  const defaults = state.personality.default || { verbosity: 2, vibe: "chill", humor: 25 };
  if (type === "source" && state.personality.sources && state.personality.sources[name]) {
    return { ...defaults, ...state.personality.sources[name] };
  }
  if (type === "project" && state.personality.projects && state.personality.projects[name]) {
    return { ...defaults, ...state.personality.projects[name] };
  }
  return defaults;
}

const VERBOSITY_LABELS = { 1: "Telegraphic", 2: "Terse", 3: "Normal", 4: "Detailed", 5: "Narrative" };

function renderPersonalityRow(type, name, { voiceHtml, speedVal, speedType, speedName } = {}) {
  const p = getPersonality(type, name);
  const nameAttr = esc(name);
  return `
    <div class="personality-controls">
      ${voiceHtml ? `<div class="personality-field">
        <label class="personality-label">Voice</label>
        ${voiceHtml}
      </div>` : ''}
      ${speedVal !== undefined ? `<div class="personality-field">
        <label class="personality-label">Speed</label>
        <input type="range" class="personality-slider speed-inline-slider" min="0.5" max="2.0" step="0.1" value="${speedVal}"
          onchange="changeSpeed('${speedType}', '${esc(speedName)}', this.value)"
          oninput="this.nextElementSibling.textContent = parseFloat(this.value).toFixed(1) + 'x'">
        <span class="personality-value">${parseFloat(speedVal).toFixed(1)}x</span>
      </div>` : ''}
      <div class="personality-field">
        <label class="personality-label">Verbosity</label>
        <input type="range" class="personality-slider" min="1" max="5" step="1" value="${p.verbosity}"
          onchange="changePersonality('${type}', '${nameAttr}', 'verbosity', this.value)"
          oninput="this.nextElementSibling.textContent = {1:'Telegraphic',2:'Terse',3:'Normal',4:'Detailed',5:'Narrative'}[this.value]">
        <span class="personality-value">${VERBOSITY_LABELS[p.verbosity] || "Terse"}</span>
      </div>
      <div class="personality-field">
        <label class="personality-label">Vibe</label>
        <select class="vibe-select" onchange="changePersonality('${type}', '${nameAttr}', 'vibe', this.value)">
          ${state.availableVibes.map(v => `<option value="${esc(v)}"${p.vibe === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
      </div>
      <div class="personality-field">
        <label class="personality-label">Humor</label>
        <input type="range" class="personality-slider humor-slider" min="0" max="100" step="5" value="${p.humor}"
          onchange="changePersonality('${type}', '${nameAttr}', 'humor', this.value)"
          oninput="this.nextElementSibling.textContent = this.value + '%'">
        <span class="personality-value">${p.humor}%</span>
      </div>
    </div>
  `;
}

function toggleQueueExpand() {
  state.queueExpanded = !state.queueExpanded;
  renderQueue();
}

function clearQueue() {
  fetch("/api/queue/clear", { method: "POST" });
  state.queue = [];
  renderQueue();
}

function clearSource(target) {
  fetch("/api/history/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
}

function startRename(source) {
  state.editingSource = source;
  renderSources();
}

function handleRenameKey(event, source) {
  if (event.key === 'Enter') {
    event.target.blur();
  } else if (event.key === 'Escape') {
    state.editingSource = null;
    renderSources();
  }
}

function handleRenameBlur(event, source) {
  if (state.editingSource === null) return; // Already cancelled via Escape
  const value = event.target.value.trim();
  const current = displayName(source);
  state.editingSource = null;
  if (value && value !== current) {
    renameSource(source, value);
  }
  renderSources();
}

async function renameSource(source, name) {
  name = name.trim();
  if (!name || (name === source && !state.sourceNames[source])) return;
  state.sourceNames[source] = name; // optimistic update
  renderSources();
  await fetch('/api/sources/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, name })
  });
}

function toggleAnnounce(name, checked, type) {
  type = type || "source";
  // Optimistic local update
  const bucket = type === "project" ? "projects" : "sources";
  if (!state.personality[bucket]) state.personality[bucket] = {};
  if (!state.personality[bucket][name]) state.personality[bucket][name] = {};
  state.personality[bucket][name].announceSource = checked;

  fetch("/api/personality", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, name, personality: { announceSource: checked } }),
  }).catch((err) => console.error("Failed to save announce setting:", err));
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

// Fetch personality from REST API as a backup (in case WS init is stale or server was restarted)
function fetchPersonality() {
  fetch("/api/personality")
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (!data) return;
      state.personality = {
        default: data.default || state.personality.default,
        sources: data.sources || state.personality.sources,
        projects: data.projects || state.personality.projects,
      };
      if (data.availableVibes) state.availableVibes = data.availableVibes;
      renderSources();
    })
    .catch(() => {});
}

connect();
