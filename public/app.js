/* ==========================================================================
   AgentVox Dashboard - WebSocket Client & UI
   ========================================================================== */

import { SynthEngine } from "./synth.js";

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
  synth: null,
  synthEnabled: false,
  telemetryFeed: [],
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
      // Initialize synth with saved settings
      if (data.synth) {
        state.synthSettings = data.synth;
      }
      renderAll();
      restoreSynthState();
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

    case "telemetry":
      if (state.synth && state.synthEnabled) {
        state.synth.onTelemetry(data);
      }
      pushTelemetryEvent(data);
      renderActivityIndicator();
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
  renderSynthControls();
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

// --- Synth Controls ---

function initSynth() {
  if (!state.synth) {
    state.synth = new SynthEngine();
  }
}

function renderSynthControls() {
  const btn = document.getElementById("synth-toggle");
  const controls = document.getElementById("synth-controls");
  if (state.synthEnabled) {
    btn.innerHTML = '<span class="synth-icon">&#9835;</span> On';
    btn.className = "btn btn-synth active";
    controls.classList.remove("hidden");
  } else {
    btn.innerHTML = '<span class="synth-icon">&#9835;</span> Off';
    btn.className = "btn btn-synth";
    controls.classList.add("hidden");
  }
}

function saveSynthSettings() {
  const s = state.synthSettings || {};
  fetch("/api/synth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: state.synthEnabled,
      masterVolume: s.masterVolume ?? 0.5,
      tempo: s.tempo ?? 128,
      swing: s.swing ?? 0,
    }),
  }).catch((err) => console.error("Failed to save synth settings:", err));
}

async function restoreSynthState() {
  const s = state.synthSettings || {};
  // Sync slider positions to saved values
  const masterPct = Math.round((s.masterVolume ?? 0.5) * 100);
  const tempo = s.tempo ?? 128;
  const swingPct = Math.round((s.swing ?? 0) * 100);
  const masterEl = document.getElementById("synth-master");
  const tempoEl = document.getElementById("synth-tempo");
  const swingEl = document.getElementById("synth-swing");
  if (masterEl) { masterEl.value = masterPct; document.getElementById("synth-master-val").textContent = masterPct + "%"; }
  if (tempoEl) { tempoEl.value = tempo; document.getElementById("synth-tempo-val").textContent = tempo; }
  if (swingEl) { swingEl.value = swingPct; document.getElementById("synth-swing-val").textContent = swingPct + "%"; }

  if (s.enabled) {
    initSynth();
    state.synthEnabled = true;
    await state.synth.start();
    state.synth.setMasterVolume(s.masterVolume ?? 0.5);
    state.synth.setTempo(tempo);
    state.synth.setSwing(s.swing ?? 0);
    startSynthAnimation();
  }
  renderSynthControls();
}

function renderActivityIndicator() {
  if (!state.synth || !state.synthEnabled) return;

  const step = state.synth.getStep();
  const stepActivity = state.synth.getStepActivity();
  const toolHits = state.synth.getToolHits();
  const lastTrigger = state.synth.getLastTrigger();
  const flash = state.synth.getFlashIntensity();
  const activity = state.synth.getActivityLevel();
  const totalEvents = state.synth.getTotalEvents();
  const barsElapsed = state.synth.getBarsElapsed();
  const eventCounts = state.synth.getEventCounts();

  // --- Step sequencer ---
  const steps = document.querySelectorAll(".seq-step");
  steps.forEach((el, i) => {
    el.classList.toggle("active", i === step);
    // Show step activity as brightness
    if (stepActivity[i] > 0.1) {
      el.classList.add("hit");
      el.style.opacity = 0.4 + stepActivity[i] * 0.6;
    } else {
      el.classList.remove("hit");
      el.style.opacity = "";
    }
  });

  // --- Pattern matrix ---
  document.querySelectorAll(".pattern-row").forEach((row) => {
    const tool = row.dataset.tool;
    const hits = toolHits[tool];
    const cells = row.querySelectorAll(".pattern-cell");
    cells.forEach((cell, i) => {
      const isLit = hits && hits.has(i);
      cell.classList.toggle("lit", isLit);
      cell.classList.toggle("active-col", i === step);
    });
  });

  // --- EVA readout ---
  const bpmEl = document.getElementById("eva-bpm");
  const barEl = document.getElementById("eva-bar");
  const evtEl = document.getElementById("eva-events");
  const activeEl = document.getElementById("eva-active");
  const toolEl = document.getElementById("eva-tool");

  if (bpmEl) bpmEl.textContent = (state.synth.bpm || 128) + " BPM";
  if (barEl) barEl.textContent = "BAR " + barsElapsed;
  if (evtEl) {
    evtEl.textContent = totalEvents + " EVT";
    evtEl.classList.toggle("highlight", totalEvents > 0 && flash > 0.3);
  }
  if (activeEl) {
    if (activity > 0.6) {
      activeEl.textContent = "ACTIVE";
      activeEl.className = "eva-datum highlight";
    } else if (activity > 0.2) {
      activeEl.textContent = "ONLINE";
      activeEl.className = "eva-datum";
    } else {
      activeEl.textContent = "IDLE";
      activeEl.className = "eva-datum";
    }
  }
  if (toolEl && lastTrigger && lastTrigger.tool) {
    toolEl.textContent = lastTrigger.tool.toUpperCase();
    toolEl.classList.toggle("highlight", flash > 0.5);
  }

  // --- Flash overlay (EVA-style) ---
  const flashEl = document.getElementById("synth-flash");
  if (flashEl) {
    if (flash > 0.5 && lastTrigger) {
      const tool = (lastTrigger.tool || "").toLowerCase();
      const type = (lastTrigger.type || "").toLowerCase();
      flashEl.className = "synth-flash";
      if (type === "error") flashEl.classList.add("flash-error");
      else if (type === "completion") flashEl.classList.add("flash-done");
      else if (tool === "read" || tool === "grep" || tool === "glob") flashEl.classList.add("flash-read");
      else if (tool === "write" || tool === "edit") flashEl.classList.add("flash-write");
      else if (tool === "bash") flashEl.classList.add("flash-bash");
      else if (tool === "task") flashEl.classList.add("flash-task");
      else flashEl.classList.add("flash-read");
    } else if (flash < 0.1) {
      flashEl.className = "synth-flash";
    }
  }

  // --- Canvas: activity waveform with step markers ---
  const canvas = document.getElementById("synth-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Draw step-aligned bars with tool coloring
  const barW = w / 16 - 2;
  for (let i = 0; i < 16; i++) {
    const x = i * (barW + 2);
    const level = stepActivity[i];
    const barH = Math.max(1, level * h * 0.85);
    const y = h - barH;

    // Color based on which tools are active on this step
    let r = 80, g = 70, b = 120; // base purple
    if (toolHits["Bash"] && toolHits["Bash"].has(i)) { r = 200; g = 60; b = 60; }
    else if (toolHits["Write"] && toolHits["Write"].has(i)) { r = 190; g = 150; b = 100; }
    else if (toolHits["Read"] && toolHits["Read"].has(i)) { r = 90; g = 150; b = 220; }
    else if (toolHits["Task"] && toolHits["Task"].has(i)) { r = 150; g = 120; b = 220; }

    const alpha = i === step ? 0.9 : (level > 0.05 ? 0.5 + level * 0.3 : 0.12);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.fillRect(x, y, barW, barH);

    // Playhead line
    if (i === step) {
      ctx.fillStyle = "rgba(167, 139, 250, 0.15)";
      ctx.fillRect(x, 0, barW, h);
    }
  }

  // Thin line across the bottom for grounding
  ctx.fillStyle = "rgba(30, 35, 48, 0.8)";
  ctx.fillRect(0, h - 1, w, 1);
}

// Start animation loop for visualizer
let synthAnimFrame;
function startSynthAnimation() {
  function animate() {
    renderActivityIndicator();
    synthAnimFrame = requestAnimationFrame(animate);
  }
  animate();
}

function stopSynthAnimation() {
  if (synthAnimFrame) {
    cancelAnimationFrame(synthAnimFrame);
    synthAnimFrame = null;
  }
  // Clear canvas
  const canvas = document.getElementById("synth-canvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// --- Telemetry Feed ---

const TOOL_ICONS = {
  Read: "\u25b7",      // right triangle
  Write: "\u25c6",     // diamond
  Edit: "\u25c6",      // diamond
  Bash: "\u25a0",      // filled square
  Grep: "\u25cb",      // circle
  Glob: "\u25cb",      // circle
  Task: "\u25b2",      // up triangle
};
const TYPE_LABELS = {
  tool_start: "START",
  tool_end: "END",
  thinking: "THINK",
  error: "ERROR",
  completion: "DONE",
  heartbeat: "PULSE",
};

function pushTelemetryEvent(data) {
  state.telemetryFeed.push({ ...data, _ts: Date.now() });
  if (state.telemetryFeed.length > 30) state.telemetryFeed.shift();
  renderTelemetryFeed();
}

function renderTelemetryFeed() {
  const feed = document.getElementById("synth-feed");
  if (!feed) return;

  if (state.telemetryFeed.length === 0) {
    feed.innerHTML = '<div class="synth-feed-empty">Waiting for events...</div>';
    return;
  }

  const now = Date.now();
  // Show last 12 events, newest at bottom
  const recent = state.telemetryFeed.slice(-12);

  feed.innerHTML = recent.map((evt) => {
    const age = (now - evt._ts) / 1000;
    const opacity = Math.max(0.25, 1 - age / 15);
    const icon = TOOL_ICONS[evt.tool] || "\u00b7";
    const label = TYPE_LABELS[evt.type] || evt.type;
    const toolName = evt.tool || "";
    const source = evt.source || "";
    const typeClass = "feed-type-" + (evt.type || "").replace(/_/g, "-");
    const time = new Date(evt._ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    return `<div class="synth-feed-item ${typeClass}" style="opacity:${opacity.toFixed(2)}">
      <span class="feed-time">${esc(time)}</span>
      <span class="feed-icon">${icon}</span>
      <span class="feed-label">${esc(label)}</span>
      ${toolName ? `<span class="feed-tool">${esc(toolName)}</span>` : ""}
      <span class="feed-source">${esc(source)}</span>
    </div>`;
  }).join("");

  // Auto-scroll to bottom
  feed.scrollTop = feed.scrollHeight;
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

document.getElementById("synth-toggle").addEventListener("click", async () => {
  initSynth();
  if (state.synthEnabled) {
    state.synthEnabled = false;
    state.synth.stop();
    stopSynthAnimation();
  } else {
    state.synthEnabled = true;
    await state.synth.start();
    const s = state.synthSettings || {};
    state.synth.setMasterVolume(s.masterVolume ?? 0.5);
    state.synth.setTempo(s.tempo ?? 128);
    state.synth.setSwing(s.swing ?? 0);
    startSynthAnimation();
  }
  renderSynthControls();
  saveSynthSettings();
});

document.getElementById("synth-master").addEventListener("input", (e) => {
  const val = parseInt(e.target.value) / 100;
  document.getElementById("synth-master-val").textContent = e.target.value + "%";
  if (state.synth) state.synth.setMasterVolume(val);
  if (!state.synthSettings) state.synthSettings = {};
  state.synthSettings.masterVolume = val;
});
document.getElementById("synth-master").addEventListener("change", () => saveSynthSettings());

document.getElementById("synth-tempo").addEventListener("input", (e) => {
  const val = parseInt(e.target.value);
  document.getElementById("synth-tempo-val").textContent = val;
  if (state.synth) state.synth.setTempo(val);
  if (!state.synthSettings) state.synthSettings = {};
  state.synthSettings.tempo = val;
});
document.getElementById("synth-tempo").addEventListener("change", () => saveSynthSettings());

document.getElementById("synth-swing").addEventListener("input", (e) => {
  const val = parseInt(e.target.value) / 100;
  document.getElementById("synth-swing-val").textContent = e.target.value + "%";
  if (state.synth) state.synth.setSwing(val);
  if (!state.synthSettings) state.synthSettings = {};
  state.synthSettings.swing = val;
});
document.getElementById("synth-swing").addEventListener("change", () => saveSynthSettings());

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

// Expose functions used by inline handlers to global scope (required for type="module")
Object.assign(window, {
  toggleQueueExpand, clearQueue, clearSource,
  toggleMute, changeVoice, changeSpeed, changePersonality,
  startRename, handleRenameKey, handleRenameBlur, toggleAnnounce,
});

// Initialize pattern matrix cells
function initPatternMatrix() {
  document.querySelectorAll(".pattern-cells").forEach((container) => {
    let html = "";
    for (let i = 0; i < 16; i++) {
      html += `<div class="pattern-cell" data-step="${i}"></div>`;
    }
    container.innerHTML = html;
  });
}
initPatternMatrix();

connect();
