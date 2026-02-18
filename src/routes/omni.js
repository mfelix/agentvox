import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import { SessionWatcher, extractActivity, findSessionFiles } from "../watcher.js";

export function createOmniRouter({ summarizer, queue, tts, config, state }) {
  const router = Router();
  let watcher = null;
  let activityBuffer = [];
  let narrationInterval = null;
  let rescanInterval = null;
  const intervalMs = (config.omni?.intervalSeconds || 45) * 1000;

  function scanForSessions() {
    if (!watcher) return;
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "", ".claude");
    const projectsDir = path.join(claudeHome, "projects");
    const files = findSessionFiles(projectsDir, 3600000);
    for (const file of files) {
      watcher.watchFile(file);
    }
  }

  function startWatcher() {
    if (watcher) return;

    watcher = new SessionWatcher({
      intervalMs: 5000,
      onActivity: (filePath, lines) => {
        const activity = extractActivity(lines);
        if (!activity.trim()) return;
        const project = path.basename(path.dirname(filePath));
        activityBuffer.push({ project, activity: activity.slice(0, 2000) });
        if (activityBuffer.length > 500) activityBuffer.shift();
      },
    });

    scanForSessions();

    rescanInterval = setInterval(() => {
      scanForSessions();
    }, 30000);

    narrationInterval = setInterval(async () => {
      if (activityBuffer.length === 0) return;
      if (state.globalMute) return;

      // Drain buffer
      const buffered = activityBuffer.splice(0);

      // Group by project, take most recent activity
      const byProject = {};
      for (const item of buffered) {
        if (!byProject[item.project]) byProject[item.project] = [];
        byProject[item.project].push(item.activity);
      }

      // Narrate each project
      for (const [project, activities] of Object.entries(byProject)) {
        if (state.muted.has(project) || state.muted.has("omni")) continue;
        const combined = activities.join("\n").slice(0, 3000);

        const { resolveVoice, resolveSpeed, resolvePersonality, resolveSourceName } = await import("../config.js");
        const voice = resolveVoice(config, project, "omni");
        const speed = resolveSpeed(config, project, "omni");
        const personality = resolvePersonality(config, project, "omni");

        let spokenText = await summarizer.summarizeOmni({
          project,
          branch: "",
          activity: combined,
        }, personality);

        if (!spokenText || spokenText.toLowerCase().includes("nothing to report")) continue;

        // Prepend source name if announceSource is enabled
        if (personality.announceSource) {
          const displayName = resolveSourceName(config, "omni").replace(/[-_.]/g, " ");
          spokenText = displayName + ". " + spokenText;
        }

        const message = {
          source: "omni",
          project,
          type: "narration",
          priority: "normal",
          spokenText,
          receivedAt: new Date().toISOString(),
        };

        state.history.push(message);

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
    }, intervalMs);

    state.omniActive = true;
    state.broadcast("omni:update", { active: true });
  }

  function stopWatcher() {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
    if (narrationInterval) {
      clearInterval(narrationInterval);
      narrationInterval = null;
    }
    if (rescanInterval) {
      clearInterval(rescanInterval);
      rescanInterval = null;
    }
    activityBuffer = [];
    state.omniActive = false;
    state.broadcast("omni:update", { active: false });
  }

  router.post("/on", (req, res) => {
    startWatcher();
    res.json({ omni: true });
  });

  router.post("/off", (req, res) => {
    stopWatcher();
    res.json({ omni: false });
  });

  router.get("/status", (req, res) => {
    res.json({ active: !!watcher });
  });

  // Auto-start if config says so
  if (config.omni?.enabled) {
    startWatcher();
  }

  return router;
}
