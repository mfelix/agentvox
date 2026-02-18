import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PriorityQueue } from "./queue.js";
import { TtsEngine } from "./tts.js";
import { Summarizer } from "./summarizer.js";
import { getConfig, AVAILABLE_VOICES, AVAILABLE_VIBES } from "./config.js";
import { createApiRouter } from "./routes/api.js";
import { createOmniRouter } from "./routes/omni.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = getConfig();
const PORT = process.env.AGENTVOX_PORT || config.port || 9876;

const app = express();
app.use(express.json({ limit: "16kb" }));

// Shared state
const state = {
  muted: new Set(),
  globalMute: false,
  history: [],
  wsClients: new Set(),
  broadcast(event, data) {
    const payload = JSON.stringify({ event, data });
    for (const client of this.wsClients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  },
};

const queue = new PriorityQueue(config.queue);
const tts = new TtsEngine(config.tts);
const summarizer = new Summarizer(config.summarization);

// API routes
app.use("/api", createApiRouter({ queue, tts, summarizer, config, state }));

// Omni mode routes
app.use("/api/omni", createOmniRouter({ summarizer, queue, tts, config, state }));

// Dashboard static files
app.use(express.static(path.join(__dirname, "..", "public")));

// HTTP server
const httpServer = http.createServer(app);

// WebSocket
const MAX_WS_CLIENTS = 50;
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (ws) => {
  if (state.wsClients.size >= MAX_WS_CLIENTS) {
    ws.close(1013, "Too many connections");
    return;
  }
  state.wsClients.add(ws);
  // Send current state on connect
  ws.send(
    JSON.stringify({
      event: "init",
      data: {
        queue: queue.pending(),
        speaking: tts.isSpeaking(),
        muted: [...state.muted],
        globalMute: state.globalMute,
        omniActive: state.omniActive || false,
        sourceNames: config.sourceNames || {},
        history: state.history.slice(-50),
        voices: {
          default: config.voices?.default || "jean",
          sources: config.voices?.sources || {},
          projects: config.voices?.projects || {},
        },
        speed: {
          default: config.speed?.default || 1.0,
          sources: config.speed?.sources || {},
          projects: config.speed?.projects || {},
        },
        availableVoices: AVAILABLE_VOICES,
        personality: {
          default: config.personality?.default || { verbosity: 2, vibe: "chill", humor: 25 },
          sources: config.personality?.sources || {},
          projects: config.personality?.projects || {},
        },
        availableVibes: AVAILABLE_VIBES,
        synth: config.synth || { enabled: false, masterVolume: 0.5, tempo: 128, swing: 0 },
      },
    })
  );
  ws.on("close", () => state.wsClients.delete(ws));
});

const server = httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`AgentVox running on http://127.0.0.1:${PORT}`);
});

export { app, server };
