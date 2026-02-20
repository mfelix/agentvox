import { Router } from "express";
import { AVAILABLE_VOICES } from "../config.js";

const VALID_PRIORITIES = ["low", "normal", "high"];
const VALID_TYPES = ["stop", "error", "narration", "info"];

export function createApiRouter({ queue, tts, summarizer, config, state }) {
  const router = Router();
  let _processChain = Promise.resolve();
  let _seqCounter = 0;

  router.post("/message", async (req, res) => {
    const { source, project, branch, worktree, sessionId, priority, type, context, summary } = req.body;

    if (!source || typeof source !== "string") {
      return res.status(400).json({ error: "source is required" });
    }
    if (source.length > 100) {
      return res.status(400).json({ error: "source must be 100 characters or fewer" });
    }
    if (!context && !summary) {
      return res.status(400).json({ error: "context or summary is required" });
    }
    for (const [field, val] of [["project", project], ["branch", branch], ["worktree", worktree], ["sessionId", sessionId]]) {
      if (val != null && (typeof val !== "string" || val.length > 200)) {
        return res.status(400).json({ error: `${field} must be a string of 200 characters or fewer` });
      }
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(", ")}` });
    }
    if (type && !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` });
    }

    const message = {
      source,
      project: project || "unknown",
      branch: branch || null,
      worktree: worktree || null,
      sessionId: sessionId || `${source}-${Date.now()}`,
      priority: priority || "normal",
      type: type || "stop",
      context: typeof context === "string" ? context.slice(0, 10000) : "",
      summary: typeof summary === "string" ? summary.slice(0, 1000) : null,
      receivedAt: new Date().toISOString(),
    };

    message.seq = _seqCounter++;
    queue.enqueue(message);
    state.broadcast("message:new", message);

    // Process sequentially — each message fully summarizes and speaks before the
    // next one starts, guaranteeing arrival-order playback even when multiple
    // agents/subagents send messages in rapid succession.
    _processChain = _processChain
      .then(() => _processMessage(message, { tts, summarizer, config, state }))
      .catch((err) => console.error("Speech processing error:", err))
      .finally(() => queue.remove(message.seq));

    res.status(202).json({ queued: true, id: message.sessionId });
  });

  router.get("/status", (req, res) => {
    res.json({
      status: "ok",
      version: "0.1.0",
      queue: { size: queue.size(), pending: queue.pending() },
      speaking: tts.isSpeaking(),
      muted: [...state.muted],
    });
  });

  router.post("/mute", (req, res) => {
    const { target } = req.body;
    if (target != null && (typeof target !== "string" || target.length > 100)) {
      return res.status(400).json({ error: "target must be a string of 100 characters or fewer" });
    }
    if (target === "all") {
      state.globalMute = true;
      tts.stop();
    } else if (target) {
      state.muted.add(target);
    }
    state.broadcast("mute:update", { muted: [...state.muted], globalMute: state.globalMute });
    res.json({ muted: [...state.muted], globalMute: state.globalMute });
  });

  router.post("/unmute", (req, res) => {
    const { target } = req.body;
    if (target != null && (typeof target !== "string" || target.length > 100)) {
      return res.status(400).json({ error: "target must be a string of 100 characters or fewer" });
    }
    if (target === "all") {
      state.globalMute = false;
    } else if (target) {
      state.muted.delete(target);
    }
    state.broadcast("mute:update", { muted: [...state.muted], globalMute: state.globalMute });
    res.json({ muted: [...state.muted], globalMute: state.globalMute });
  });

  router.get("/voices", async (req, res) => {
    const { AVAILABLE_VOICES } = await import("../config.js");
    res.json({
      default: config.voices?.default || "jean",
      sources: config.voices?.sources || {},
      projects: config.voices?.projects || {},
      available: AVAILABLE_VOICES,
    });
  });

  router.post("/voices", async (req, res) => {
    const { type, name, voice } = req.body;

    if (voice && !AVAILABLE_VOICES.includes(voice)) {
      return res.status(400).json({ error: `voice must be one of: ${AVAILABLE_VOICES.join(", ")}` });
    }
    if (name != null && (typeof name !== "string" || name.length > 100)) {
      return res.status(400).json({ error: "name must be a string of 100 characters or fewer" });
    }
    if (!["default", "source", "project"].includes(type)) {
      return res.status(400).json({ error: "type must be 'default', 'source', or 'project'" });
    }

    if (!config.voices) config.voices = {};

    if (type === "default") {
      config.voices.default = voice || "jean";
    } else if (type === "source") {
      if (!config.voices.sources) config.voices.sources = {};
      if (!voice) {
        delete config.voices.sources[name];
      } else {
        config.voices.sources[name] = voice;
      }
    } else if (type === "project") {
      if (!config.voices.projects) config.voices.projects = {};
      if (!voice) {
        delete config.voices.projects[name];
      } else {
        config.voices.projects[name] = voice;
      }
    }

    const { saveVoiceConfig } = await import("../config.js");
    saveVoiceConfig(config.voices);

    state.broadcast("voices:update", {
      default: config.voices.default || "jean",
      sources: config.voices.sources || {},
      projects: config.voices.projects || {},
    });

    res.json({
      default: config.voices.default || "jean",
      sources: config.voices.sources || {},
      projects: config.voices.projects || {},
    });
  });

  router.get("/speed", (req, res) => {
    res.json({
      default: config.speed?.default || 1.0,
      sources: config.speed?.sources || {},
      projects: config.speed?.projects || {},
    });
  });

  router.post("/speed", async (req, res) => {
    const { type, name, speed } = req.body;

    if (speed != null && (typeof speed !== "number" || speed < 0.5 || speed > 2.0)) {
      return res.status(400).json({ error: "speed must be a number between 0.5 and 2.0" });
    }
    if (name != null && (typeof name !== "string" || name.length > 100)) {
      return res.status(400).json({ error: "name must be a string of 100 characters or fewer" });
    }

    if (!config.speed) config.speed = {};

    if (type === "default") {
      config.speed.default = speed != null ? speed : 1.0;
    } else if (type === "source") {
      if (!config.speed.sources) config.speed.sources = {};
      if (speed == null) {
        delete config.speed.sources[name];
      } else {
        config.speed.sources[name] = speed;
      }
    } else if (type === "project") {
      if (!config.speed.projects) config.speed.projects = {};
      if (speed == null) {
        delete config.speed.projects[name];
      } else {
        config.speed.projects[name] = speed;
      }
    } else {
      return res.status(400).json({ error: "type must be 'default', 'source', or 'project'" });
    }

    const { saveSpeedConfig } = await import("../config.js");
    saveSpeedConfig(config.speed);

    state.broadcast("speed:update", {
      default: config.speed.default || 1.0,
      sources: config.speed.sources || {},
      projects: config.speed.projects || {},
    });

    res.json({
      default: config.speed.default || 1.0,
      sources: config.speed.sources || {},
      projects: config.speed.projects || {},
    });
  });

  function getAudioState() {
    return {
      gain: config.audio?.gain ?? 1.0,
      compressor: config.audio?.compressor ?? false,
      limiter: config.audio?.limiter ?? false,
      eq: { bass: 0, mid: 0, treble: 0, ...config.audio?.eq },
      reverb: { enabled: false, amount: 30, ...config.audio?.reverb },
    };
  }

  router.get("/audio", (req, res) => {
    res.json(getAudioState());
  });

  router.post("/audio", async (req, res) => {
    const { gain, compressor, limiter, eq, reverb } = req.body;

    if (!config.audio) config.audio = {};

    if (typeof gain === "number") {
      if (gain < 0.5 || gain > 5.0) {
        return res.status(400).json({ error: "gain must be between 0.5 and 5.0" });
      }
      config.audio.gain = gain;
    }
    if (typeof compressor === "boolean") config.audio.compressor = compressor;
    if (typeof limiter === "boolean") config.audio.limiter = limiter;

    if (eq && typeof eq === "object") {
      if (!config.audio.eq) config.audio.eq = { bass: 0, mid: 0, treble: 0 };
      for (const band of ["bass", "mid", "treble"]) {
        if (typeof eq[band] === "number") {
          if (eq[band] < -12 || eq[band] > 12) {
            return res.status(400).json({ error: `${band} must be between -12 and 12` });
          }
          config.audio.eq[band] = eq[band];
        }
      }
    }

    if (reverb && typeof reverb === "object") {
      if (!config.audio.reverb) config.audio.reverb = { enabled: false, amount: 30 };
      if (typeof reverb.enabled === "boolean") config.audio.reverb.enabled = reverb.enabled;
      if (typeof reverb.amount === "number") {
        if (reverb.amount < 0 || reverb.amount > 100) {
          return res.status(400).json({ error: "reverb amount must be between 0 and 100" });
        }
        config.audio.reverb.amount = reverb.amount;
      }
    }

    const { saveAudioConfig } = await import("../config.js");
    saveAudioConfig(config.audio);

    const audioState = getAudioState();
    state.broadcast("audio:update", audioState);
    res.json(audioState);
  });

  router.get("/personality", async (req, res) => {
    const { AVAILABLE_VIBES } = await import("../config.js");
    res.json({
      default: config.personality?.default || { verbosity: 2, vibe: "chill", humor: 25 },
      sources: config.personality?.sources || {},
      projects: config.personality?.projects || {},
      availableVibes: AVAILABLE_VIBES,
    });
  });

  router.post("/personality", async (req, res) => {
    const { type, name, personality } = req.body;
    const { AVAILABLE_VIBES } = await import("../config.js");

    if (personality) {
      if (personality.verbosity != null && (personality.verbosity < 1 || personality.verbosity > 5)) {
        return res.status(400).json({ error: "verbosity must be 1-5" });
      }
      if (personality.vibe && !AVAILABLE_VIBES.includes(personality.vibe)) {
        return res.status(400).json({ error: `vibe must be one of: ${AVAILABLE_VIBES.join(", ")}` });
      }
      if (personality.humor != null && (personality.humor < 0 || personality.humor > 100)) {
        return res.status(400).json({ error: "humor must be 0-100" });
      }
      if (personality.announceSource != null && typeof personality.announceSource !== "boolean") {
        return res.status(400).json({ error: "announceSource must be a boolean" });
      }
    }

    if (!config.personality) config.personality = {};

    const defaults = { verbosity: 2, vibe: "chill", humor: 25 };

    if (type === "default") {
      config.personality.default = { ...(config.personality.default || defaults), ...personality };
    } else if (type === "source") {
      if (!config.personality.sources) config.personality.sources = {};
      if (!personality) {
        delete config.personality.sources[name];
      } else {
        config.personality.sources[name] = { ...(config.personality.sources[name] || {}), ...personality };
      }
    } else if (type === "project") {
      if (!config.personality.projects) config.personality.projects = {};
      if (!personality) {
        delete config.personality.projects[name];
      } else {
        config.personality.projects[name] = { ...(config.personality.projects[name] || {}), ...personality };
      }
    } else {
      return res.status(400).json({ error: "type must be 'default', 'source', or 'project'" });
    }

    const { savePersonalityConfig } = await import("../config.js");
    savePersonalityConfig(config.personality);

    state.broadcast("personality:update", {
      default: config.personality.default || defaults,
      sources: config.personality.sources || {},
      projects: config.personality.projects || {},
    });

    res.json({
      default: config.personality.default || defaults,
      sources: config.personality.sources || {},
      projects: config.personality.projects || {},
    });
  });

  router.get("/sources/names", (req, res) => {
    res.json({ sourceNames: config.sourceNames || {} });
  });

  router.post("/sources/rename", async (req, res) => {
    const { source, name } = req.body;
    if (!source || typeof source !== "string") {
      return res.status(400).json({ error: "source is required" });
    }
    if (source.length > 100) {
      return res.status(400).json({ error: "source must be 100 characters or fewer" });
    }

    if (!config.sourceNames) config.sourceNames = {};

    // Empty or matching original name = reset to default
    const trimmed = (name || "").replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!trimmed || trimmed === source) {
      delete config.sourceNames[source];
    } else {
      if (trimmed.length > 50) {
        return res.status(400).json({ error: "name must be 50 characters or fewer" });
      }
      config.sourceNames[source] = trimmed;
    }

    const { saveSourceNames } = await import("../config.js");
    saveSourceNames(config.sourceNames);

    state.broadcast("sources:rename", { source, name, sourceNames: config.sourceNames });

    res.json({ ok: true });
  });

  router.delete("/sources/:source", async (req, res) => {
    const source = req.params.source;
    if (!source || source.length > 100) {
      return res.status(400).json({ error: "invalid source" });
    }

    // Remove from config
    if (config.voices?.sources) delete config.voices.sources[source];
    if (config.speed?.sources) delete config.speed.sources[source];
    if (config.personality?.sources) delete config.personality.sources[source];
    if (config.sourceNames) delete config.sourceNames[source];

    // Remove from runtime state
    state.muted.delete(source);
    state.history = state.history.filter((m) => m.source !== source);

    // Persist
    const { saveVoiceConfig, saveSpeedConfig, savePersonalityConfig, saveSourceNames } = await import("../config.js");
    if (config.voices) saveVoiceConfig(config.voices);
    if (config.speed) saveSpeedConfig(config.speed);
    if (config.personality) savePersonalityConfig(config.personality);
    saveSourceNames(config.sourceNames || {});

    state.broadcast("source:removed", { source });
    res.json({ removed: true, source });
  });

  router.post("/queue/clear", (req, res) => {
    queue.drain();
    state.broadcast("queue:cleared", {});
    res.json({ cleared: true });
  });

  router.post("/history/clear", (req, res) => {
    const { target } = req.body;
    if (!target) {
      return res.status(400).json({ error: "target is required" });
    }
    // Remove messages matching source OR project
    state.history = state.history.filter(
      (m) => m.source !== target && m.project !== target
    );
    state.broadcast("history:cleared", { target });
    res.json({ cleared: true, target });
  });

  const PREVIEW_PHRASES = ["hi", "hello", "meow", "howdy", "yo"];

  router.post("/tts/preview", async (req, res) => {
    const { voice } = req.body;
    if (!voice) {
      return res.status(400).json({ error: "voice is required" });
    }
    if (!AVAILABLE_VOICES.includes(voice)) {
      return res.status(400).json({ error: `voice must be one of: ${AVAILABLE_VOICES.join(", ")}` });
    }
    const phrase = PREVIEW_PHRASES[Math.floor(Math.random() * PREVIEW_PHRASES.length)];
    res.json({ previewing: true, voice, phrase });
    const audio = getAudioState();
    tts.speak(phrase, voice, 1.0, audio).catch(() => {});
  });

  router.get("/history", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json({ history: state.history.slice(-limit) });
  });

  return router;
}

async function _processMessage(message, { tts, summarizer, config, state }) {
  // Check mute — still remove from frontend queue so items don't pile up
  if (state.globalMute || state.muted.has(message.source) || state.muted.has(message.project)) {
    state.broadcast("message:skipped", message);
    return;
  }

  // Resolve voice, speed, and personality
  const { resolveVoice, resolveSpeed, resolvePersonality, resolveSourceName } = await import("../config.js");
  const voice = resolveVoice(config, message.project, message.source);
  const speed = resolveSpeed(config, message.project, message.source);
  const personality = resolvePersonality(config, message.project, message.source);

  // Summarize with personality
  let spokenText = await summarizer.summarize(message, personality);

  // LLM determined this event is noise — skip it entirely
  if (!spokenText) {
    state.broadcast("message:skipped", message);
    return;
  }

  // Prepend source name if announceSource is enabled
  if (personality.announceSource) {
    const displayName = resolveSourceName(config, message.source).replace(/[-_.]/g, " ");
    spokenText = displayName + ". " + spokenText;
  }

  message.spokenText = spokenText;

  // Add to history
  state.history.push(message);
  if (state.history.length > 200) state.history.shift();

  // Re-check mute — summarization may have taken a while
  if (state.globalMute || state.muted.has(message.source) || state.muted.has(message.project)) {
    state.broadcast("message:skipped", message);
    return;
  }

  // Speak with audio processing
  const audio = {
    gain: config.audio?.gain ?? 1.0,
    compressor: config.audio?.compressor ?? false,
    limiter: config.audio?.limiter ?? false,
    eq: { bass: 0, mid: 0, treble: 0, ...config.audio?.eq },
    reverb: { enabled: false, amount: 30, ...config.audio?.reverb },
  };
  state.broadcast("speaking:start", { ...message, voice, speed });
  await tts.speak(spokenText, voice, speed, audio);
  state.broadcast("speaking:done", message);
}
