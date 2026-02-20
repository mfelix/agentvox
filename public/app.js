/* ==========================================================================
   AgentVox Presence — WebSocket Client & UI
   ========================================================================== */

const state = {
  queue: [],
  history: [],
  speaking: null,
  muted: [],
  globalMute: false,
  omniActive: false,
  sources: new Map(),  // source -> lastSeen timestamp
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
  audio: { gain: 1.0, compressor: false, limiter: false, eq: { bass: 0, mid: 0, treble: 0 }, reverb: { enabled: false, amount: 30 } },
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
        if (m.source) state.sources.set(m.source, Date.parse(m.receivedAt) || Date.now());
        if (m.project && m.project !== "unknown") state.projects.add(m.project);
      });
      // Initialize audio settings
      if (data.audio) {
        state.audio = data.audio;
      }
      renderAll();
      // Fetch latest personality from REST API to ensure we have persisted values
      fetchPersonality();
      break;

    case "message:new":
      if (data.source) state.sources.set(data.source, Date.now());
      if (data.project && data.project !== "unknown") state.projects.add(data.project);
      state.queue.push(data);
      renderQueue();
      renderSources();
      break;

    case "message:skipped":
      state.queue = state.queue.filter((m) => m.sessionId !== data.sessionId);
      renderQueue();
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
      if (data.source) state.sources.set(data.source, Date.now());
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

    case "audio:update":
      state.audio = {
        gain: data.gain ?? 1.0,
        compressor: data.compressor ?? false,
        limiter: data.limiter ?? false,
        eq: { bass: 0, mid: 0, treble: 0, ...data.eq },
        reverb: { enabled: false, amount: 30, ...data.reverb },
      };
      renderAudioControls();
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

    case "source:removed":
      state.sources.delete(data.source);
      state.history = state.history.filter((m) => m.source !== data.source);
      state.muted = state.muted.filter((m) => m !== data.source);
      delete state.sourceNames[data.source];
      if (state.voices.sources) delete state.voices.sources[data.source];
      if (state.speed.sources) delete state.speed.sources[data.source];
      if (state.personality.sources) delete state.personality.sources[data.source];
      if (state.speaking && state.speaking.source === data.source) state.speaking = null;
      renderAll();
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

function sourceColor(source) {
  if (source === "claude-code") return "var(--claude-code)";
  if (source === "codex") return "var(--codex)";
  if (source === "omni") return "var(--omni)";
  return "var(--custom)";
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  return hours + "h ago";
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

// --- Render Functions ---

function renderAll() {
  renderConnectionStatus();
  renderSpeaking();
  renderQueue();
  renderHistory();
  renderSources();
  renderMuteButton();
  renderOmniButton();
  renderAudioControls();
}

function renderConnectionStatus() {
  const el = document.getElementById("connection-status");
  if (!el) return;
  if (state.connected) {
    el.className = "connection-dot connected";
    el.title = "Connected";
  } else {
    el.className = "connection-dot disconnected";
    el.title = "Disconnected - reconnecting...";
  }
}

function renderSpeaking() {
  const sourceEl = document.getElementById("voice-source");
  const textEl = document.getElementById("voice-text");
  const waveform = document.getElementById("waveform");
  if (!sourceEl || !textEl || !waveform) return;

  if (state.speaking) {
    const src = state.speaking.source || "";
    const color = sourceColor(src);

    // Source label
    sourceEl.textContent = displayName(src);
    sourceEl.style.color = color;

    // Spoken text
    textEl.textContent = state.speaking.spokenText || state.speaking.context || "";
    textEl.classList.remove("idle");

    // Waveform
    waveform.classList.add("active");
    waveform.querySelectorAll(".wave-bar").forEach((bar) => {
      bar.style.background = color;
    });

    // Speaking orb
    document.querySelectorAll("#source-orbs .orb").forEach((orb) => {
      orb.classList.remove("speaking");
    });
    const activeOrb = document.querySelector(`#source-orbs .orb[data-source="${CSS.escape(src)}"]`);
    if (activeOrb) activeOrb.classList.add("speaking");
  } else {
    textEl.classList.add("idle");
    waveform.classList.remove("active");
    document.querySelectorAll("#source-orbs .orb").forEach((orb) => {
      orb.classList.remove("speaking");
    });
  }
}

function renderQueue() {
  const indicator = document.getElementById("queue-indicator");
  const textEl = document.getElementById("queue-text");
  const itemsEl = document.getElementById("queue-items");
  if (!indicator) return;

  const count = state.queue.length;

  if (count === 0) {
    indicator.classList.remove("visible");
    return;
  }

  indicator.classList.add("visible");
  if (textEl) textEl.textContent = count + " queued";

  if (itemsEl) {
    itemsEl.innerHTML = state.queue
      .map((m) => {
        const color = sourceColor(m.source);
        const text = esc(truncate(m.context || m.summary || m.spokenText || "", 100));
        return `<div class="queue-item">
          <div class="queue-item-dot" style="background: ${color}"></div>
          <div class="queue-item-text">${text}</div>
        </div>`;
      })
      .join("");
  }
}

function renderHistory() {
  const stream = document.getElementById("message-stream");
  if (!stream) return;

  const recent = state.history.slice(-5).reverse();
  const clearBtn = document.getElementById("clear-stream");

  if (recent.length === 0) {
    stream.innerHTML = "";
    if (clearBtn) clearBtn.classList.remove("visible");
    return;
  }

  if (clearBtn) clearBtn.classList.add("visible");

  stream.innerHTML = recent
    .map((m) => {
      const color = sourceColor(m.source);
      const text = esc(truncate(m.spokenText || m.context || "", 120));
      const time = timeAgo(m.receivedAt);
      return `<div class="stream-msg">
        <div class="stream-dot" style="background: ${color}"></div>
        <div class="stream-text">${text}</div>
        <div class="stream-time">${esc(time)}</div>
      </div>`;
    })
    .join("");
}

function renderSources() {
  const container = document.getElementById("source-orbs");
  if (!container) return;

  const allSources = [...state.sources.keys()];
  const allProjects = [...state.projects];

  if (allSources.length === 0 && allProjects.length === 0) {
    container.innerHTML = "";
    return;
  }

  let html = "";

  // Source orbs
  for (const s of allSources) {
    html += buildOrbHtml(s, "source");
  }

  // Project orbs
  for (const p of allProjects) {
    html += buildOrbHtml(p, "project");
  }

  container.innerHTML = html;
}

function buildOrbHtml(name, type) {
  const isMuted = state.muted.includes(name);
  const isSpeaking = state.speaking && state.speaking.source === name;
  const color = sourceColor(name);
  const dName = displayName(name);
  const escapedName = esc(name);
  const defaultVoice = state.voices.default || "jean";

  // Determine voice for this source/project
  const voiceBucket = type === "project" ? state.voices.projects : state.voices.sources;
  const currentVoice = (voiceBucket && voiceBucket[name]) || "";

  // Speed
  const speedBucket = type === "project" ? state.speed.projects : state.speed.sources;
  const currentSpeed = (speedBucket && speedBucket[name]) || state.speed.default || 1.0;
  const speedPercent = Math.round(currentSpeed * 100);

  // Personality (vibe)
  const p = getPersonality(type, name);

  // Orb CSS classes
  let orbClasses = "orb";
  if (isMuted) orbClasses += " muted";
  if (isSpeaking) orbClasses += " speaking";

  // For unknown sources, use a data attribute for custom color
  const isKnown = name === "claude-code" || name === "codex" || name === "omni";
  const orbInnerStyle = !isKnown ? `style="background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.3), var(--custom) 60%, rgba(100,100,100,0.8))"` : "";
  const orbGlowStyle = !isKnown ? `style="background: var(--custom)"` : "";

  // Voice options
  const voiceOptions = state.availableVoices
    .map((v) => `<option value="${esc(v)}"${currentVoice === v ? " selected" : ""}>${esc(v)}</option>`)
    .join("");

  // Vibe chips
  const vibeChips = state.availableVibes
    .map((v) => `<button class="vibe-chip${p.vibe === v ? " active" : ""}" data-vibe="${esc(v)}">${esc(v)}</button>`)
    .join("");

  return `<div class="orb-container" data-source="${escapedName}" data-type="${type}">
    <div class="${orbClasses}" data-source="${escapedName}">
      <div class="orb-inner" ${orbInnerStyle}></div>
      <div class="orb-glow" ${orbGlowStyle}></div>
    </div>
    <div class="orb-mute-line"></div>
    <div class="orb-tooltip">${esc(dName)}</div>
    <div class="source-settings" id="settings-${escapedName}">
      <div class="source-settings-header">
        <div class="source-settings-name">
          <div class="source-settings-dot" style="background: ${color}"></div>
          <span>${esc(dName)}</span>
        </div>
        <button class="source-settings-close" aria-label="Close">&times;</button>
      </div>
      <div class="source-settings-row">
        <div class="source-settings-label">Voice</div>
        <select class="source-voice-select" data-source="${escapedName}">
          <option value=""${!currentVoice ? " selected" : ""}>default (${esc(defaultVoice)})</option>
          ${voiceOptions}
        </select>
      </div>
      <div class="source-settings-row">
        <div class="source-settings-label">Speed</div>
        <div class="speed-control">
          <input type="range" min="50" max="200" value="${speedPercent}" class="speed-slider" data-source="${escapedName}">
          <span class="speed-value">${parseFloat(currentSpeed).toFixed(1)}x</span>
        </div>
      </div>
      <div class="source-settings-row">
        <div class="source-settings-label">Vibe</div>
        <div class="vibe-chips">${vibeChips}</div>
      </div>
      <div class="source-settings-row mute-source-row">
        <span class="mute-source-label">Mute source</span>
        <button class="toggle source-mute-toggle${isMuted ? " on" : ""}" data-source="${escapedName}" aria-label="Mute source"></button>
      </div>
      <button class="source-remove-btn" data-source="${escapedName}" aria-label="Remove source">Remove source</button>
    </div>
  </div>`;
}

function renderMuteButton() {
  const btn = document.getElementById("mute-all");
  if (!btn) return;
  const speakerIcon = btn.querySelector(".speaker-icon");
  const mutedIcon = btn.querySelector(".speaker-muted-icon");

  if (state.globalMute) {
    if (mutedIcon) mutedIcon.style.display = "block";
    if (speakerIcon) speakerIcon.style.display = "none";
    btn.classList.add("muted-state");
  } else {
    if (mutedIcon) mutedIcon.style.display = "none";
    if (speakerIcon) speakerIcon.style.display = "block";
    btn.classList.remove("muted-state");
  }
}

function renderOmniButton() {
  const toggle = document.getElementById("omni-toggle");
  const label = document.getElementById("omni-label");
  if (!toggle) return;

  if (state.omniActive) {
    toggle.classList.add("on");
    if (label) label.classList.add("active");
  } else {
    toggle.classList.remove("on");
    if (label) label.classList.remove("active");
  }
}

function renderAudioControls() {
  const gainEl = document.getElementById("audio-gain");
  const gainValEl = document.getElementById("audio-gain-val");
  const compEl = document.getElementById("audio-compressor");
  const limiterEl = document.getElementById("audio-limiter");

  if (gainEl) {
    gainEl.value = Math.round(state.audio.gain * 100);
    if (gainValEl) gainValEl.textContent = Math.round(state.audio.gain * 100) + "%";
  }
  if (compEl) compEl.classList.toggle("on", state.audio.compressor);
  if (limiterEl) limiterEl.classList.toggle("on", state.audio.limiter);

  // EQ
  const eq = state.audio.eq || {};
  for (const band of ["bass", "mid", "treble"]) {
    const el = document.getElementById(`audio-eq-${band}`);
    const valEl = document.getElementById(`audio-eq-${band}-val`);
    if (el) {
      el.value = eq[band] || 0;
      const v = eq[band] || 0;
      if (valEl) valEl.textContent = (v > 0 ? "+" : "") + v + " dB";
    }
  }

  // Reverb
  const reverb = state.audio.reverb || {};
  const reverbEl = document.getElementById("audio-reverb");
  const reverbAmtEl = document.getElementById("audio-reverb-amount");
  const reverbAmtValEl = document.getElementById("audio-reverb-amount-val");
  const reverbAmtSection = document.getElementById("reverb-amount");

  if (reverbEl) reverbEl.classList.toggle("on", reverb.enabled);
  if (reverbAmtEl) {
    reverbAmtEl.value = reverb.amount ?? 30;
    if (reverbAmtValEl) reverbAmtValEl.textContent = (reverb.amount ?? 30) + "%";
  }
  if (reverbAmtSection) {
    reverbAmtSection.classList.toggle("visible", !!reverb.enabled);
  }
}

// --- API Functions ---

function saveAudioSettings() {
  fetch("/api/audio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.audio),
  }).catch((err) => console.error("Failed to save audio settings:", err));
}

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

function toggleQueueExpand() {
  // No-op in zen UI (queue is now a popup)
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

function removeSource(source) {
  fetch(`/api/sources/${encodeURIComponent(source)}`, { method: "DELETE" });
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

// --- Event Listeners (static elements) ---

// Mute All button
document.getElementById("mute-all").addEventListener("click", () => {
  toggleGlobalMute();
});

// Clear message stream
document.getElementById("clear-stream").addEventListener("click", () => {
  state.history = [];
  renderHistory();
});

// Omni toggle
document.getElementById("omni-toggle").addEventListener("click", () => {
  const endpoint = state.omniActive ? "/api/omni/off" : "/api/omni/on";
  fetch(endpoint, { method: "POST" });
});

// Gear button -> toggle audio settings panel
document.getElementById("gear-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const panel = document.getElementById("audio-settings");
  panel.classList.toggle("open");
});

// Audio settings panel -> prevent close on click inside
document.getElementById("audio-settings").addEventListener("click", (e) => {
  e.stopPropagation();
});

// Gain slider
document.getElementById("audio-gain").addEventListener("input", (e) => {
  const val = parseInt(e.target.value) / 100;
  document.getElementById("audio-gain-val").textContent = e.target.value + "%";
  state.audio.gain = val;
});
document.getElementById("audio-gain").addEventListener("change", () => saveAudioSettings());

// Compressor pill
document.getElementById("audio-compressor").addEventListener("click", () => {
  state.audio.compressor = !state.audio.compressor;
  document.getElementById("audio-compressor").classList.toggle("on", state.audio.compressor);
  saveAudioSettings();
});

// Limiter pill
document.getElementById("audio-limiter").addEventListener("click", () => {
  state.audio.limiter = !state.audio.limiter;
  document.getElementById("audio-limiter").classList.toggle("on", state.audio.limiter);
  saveAudioSettings();
});

// Reverb pill
document.getElementById("audio-reverb").addEventListener("click", () => {
  if (!state.audio.reverb) state.audio.reverb = {};
  state.audio.reverb.enabled = !state.audio.reverb.enabled;
  document.getElementById("audio-reverb").classList.toggle("on", state.audio.reverb.enabled);
  document.getElementById("reverb-amount").classList.toggle("visible", state.audio.reverb.enabled);
  saveAudioSettings();
});

// EQ bands
for (const band of ["bass", "mid", "treble"]) {
  document.getElementById(`audio-eq-${band}`).addEventListener("input", (e) => {
    const v = parseInt(e.target.value);
    document.getElementById(`audio-eq-${band}-val`).textContent = (v > 0 ? "+" : "") + v + " dB";
    if (!state.audio.eq) state.audio.eq = {};
    state.audio.eq[band] = v;
  });
  document.getElementById(`audio-eq-${band}`).addEventListener("change", () => saveAudioSettings());
}

// Reverb amount slider
document.getElementById("audio-reverb-amount").addEventListener("input", (e) => {
  const v = parseInt(e.target.value);
  document.getElementById("audio-reverb-amount-val").textContent = v + "%";
  if (!state.audio.reverb) state.audio.reverb = {};
  state.audio.reverb.amount = v;
});
document.getElementById("audio-reverb-amount").addEventListener("change", () => saveAudioSettings());

// Queue indicator click -> toggle popup
document.getElementById("queue-indicator").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("queue-popup").classList.toggle("open");
});

// Queue popup -> prevent close on click inside
document.getElementById("queue-popup").addEventListener("click", (e) => {
  e.stopPropagation();
});

// Queue clear button
document.getElementById("queue-clear-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  clearQueue();
  document.getElementById("queue-popup").classList.remove("open");
});

// --- Event Delegation for Source Orbs ---

document.getElementById("source-orbs").addEventListener("click", (e) => {
  e.stopPropagation();

  // Close button
  const closeBtn = e.target.closest(".source-settings-close");
  if (closeBtn) {
    const panel = closeBtn.closest(".source-settings");
    if (panel) panel.classList.remove("open");
    return;
  }

  // Prevent clicks inside settings panel from toggling the panel
  if (e.target.closest(".source-settings")) {
    // Voice select
    const voiceSelect = e.target.closest(".source-voice-select");
    if (voiceSelect) return; // handled by change event

    // Speed slider
    const speedSlider = e.target.closest(".speed-slider");
    if (speedSlider) return; // handled by input/change events

    // Vibe chip
    const vibeChip = e.target.closest(".vibe-chip");
    if (vibeChip) {
      const container = vibeChip.closest(".orb-container");
      const sourceName = container && container.dataset.source;
      const sourceType = container && container.dataset.type || "source";
      const vibe = vibeChip.dataset.vibe;
      if (sourceName && vibe) {
        changePersonality(sourceType, sourceName, "vibe", vibe);
        // Update active chip visually
        vibeChip.closest(".vibe-chips").querySelectorAll(".vibe-chip").forEach((c) => c.classList.remove("active"));
        vibeChip.classList.add("active");
      }
      return;
    }

    // Mute toggle
    const muteToggle = e.target.closest(".source-mute-toggle");
    if (muteToggle) {
      const sourceName = muteToggle.dataset.source;
      if (sourceName) toggleMute(sourceName);
      return;
    }

    // Remove source
    const removeBtn = e.target.closest(".source-remove-btn");
    if (removeBtn) {
      const sourceName = removeBtn.dataset.source;
      if (sourceName) removeSource(sourceName);
      return;
    }

    return; // Don't toggle panel for other clicks inside settings
  }

  // Orb click -> toggle settings panel
  const orb = e.target.closest(".orb");
  if (orb) {
    const container = orb.closest(".orb-container");
    const panel = container && container.querySelector(".source-settings");
    if (!panel) return;

    // Close all other panels first
    document.querySelectorAll("#source-orbs .source-settings.open").forEach((p) => {
      if (p !== panel) p.classList.remove("open");
    });
    panel.classList.toggle("open");
    return;
  }
});

// Voice select change (event delegation via capture)
document.getElementById("source-orbs").addEventListener("change", (e) => {
  const voiceSelect = e.target.closest(".source-voice-select");
  if (voiceSelect) {
    const container = voiceSelect.closest(".orb-container");
    const sourceName = voiceSelect.dataset.source;
    const sourceType = container && container.dataset.type || "source";
    changeVoice(sourceType, sourceName, voiceSelect.value);
    return;
  }

  // Speed slider change
  const speedSlider = e.target.closest(".speed-slider");
  if (speedSlider) {
    const container = speedSlider.closest(".orb-container");
    const sourceName = speedSlider.dataset.source;
    const sourceType = container && container.dataset.type || "source";
    const speedVal = parseFloat(speedSlider.value) / 100;
    changeSpeed(sourceType, sourceName, speedVal);
    return;
  }
});

// Speed slider input (live display update)
document.getElementById("source-orbs").addEventListener("input", (e) => {
  const speedSlider = e.target.closest(".speed-slider");
  if (speedSlider) {
    const speedValue = speedSlider.closest(".speed-control").querySelector(".speed-value");
    if (speedValue) {
      speedValue.textContent = (parseFloat(speedSlider.value) / 100).toFixed(1) + "x";
    }
  }
});

// Click outside -> close all panels
document.addEventListener("click", () => {
  // Close all source settings
  document.querySelectorAll("#source-orbs .source-settings.open").forEach((p) => {
    p.classList.remove("open");
  });
  // Close audio settings
  document.getElementById("audio-settings").classList.remove("open");
  // Close queue popup
  document.getElementById("queue-popup").classList.remove("open");
});

// Expose functions used by inline handlers to global scope (required for type="module")
Object.assign(window, {
  toggleQueueExpand, clearQueue, clearSource, removeSource,
  toggleMute, changeVoice, changeSpeed, changePersonality,
  startRename, handleRenameKey, handleRenameBlur, toggleAnnounce,
});

// Auto-expire source orbs after 10 minutes of inactivity
const SOURCE_EXPIRY_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [source, lastSeen] of state.sources) {
    if (now - lastSeen > SOURCE_EXPIRY_MS) {
      state.sources.delete(source);
      changed = true;
    }
  }
  if (changed) renderSources();
}, 30000);

connect();
