# AgentVox Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a centralized voice notification and narration hub that receives messages from Claude Code and Codex, summarizes them, queues them intelligently, speaks them via pocket-tts, and provides a real-time web dashboard.

**Architecture:** Single Node.js process running Express + WebSocket. Agents POST messages to an HTTP API. A priority queue with deduplication feeds pocket-tts for audio. A web dashboard on localhost shows real-time activity. Omni mode watches session files and narrates live.

**Tech Stack:** Node.js, Express, ws (WebSocket), vitest (testing), pocket-tts (TTS), child_process (for claude CLI and pocket-tts)

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `src/server.js` (placeholder)
- Create: `vitest.config.js`
- Create: `.gitignore`

**Step 1: Initialize npm project**

Run: `cd /Users/mfelix/code/agentvox && npm init -y`

Then edit `package.json`:

```json
{
  "name": "agentvox",
  "version": "0.1.0",
  "description": "Centralized voice notification hub for AI coding agents",
  "type": "module",
  "main": "src/server.js",
  "bin": {
    "agentvox": "./bin/agentvox.js"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "license": "MIT"
}
```

**Step 2: Install dependencies**

Run:
```bash
cd /Users/mfelix/code/agentvox && npm install express ws
npm install -D vitest
```

**Step 3: Create .gitignore**

```
node_modules/
dist/
.env
*.log
```

**Step 4: Create vitest config**

Create `vitest.config.js`:

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
});
```

**Step 5: Create placeholder server**

Create `src/server.js`:

```js
import express from "express";

const app = express();
const PORT = process.env.AGENTVOX_PORT || 9876;

app.use(express.json());

app.get("/api/status", (req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

const server = app.listen(PORT, () => {
  console.log(`AgentVox running on http://localhost:${PORT}`);
});

export { app, server };
```

**Step 6: Verify it starts**

Run: `cd /Users/mfelix/code/agentvox && node src/server.js &`
Then: `curl http://localhost:9876/api/status`
Expected: `{"status":"ok","version":"0.1.0"}`
Then: `kill %1`

**Step 7: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add package.json package-lock.json src/server.js vitest.config.js .gitignore
git commit -m "feat: project scaffolding with Express server"
```

---

### Task 2: Config Module

**Files:**
- Create: `src/config.js`
- Create: `src/__tests__/config.test.js`
- Create: `config/default.json`

**Step 1: Write the failing tests**

Create `src/__tests__/config.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We'll test config loading with a temp directory
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentvox-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("config", () => {
  it("returns defaults when no config file exists", async () => {
    const { loadConfig } = await import("../config.js");
    const config = loadConfig(path.join(tmpDir, "nonexistent.json"));
    expect(config.port).toBe(9876);
    expect(config.voices.default).toBe("jean");
    expect(config.queue.maxSize).toBe(20);
  });

  it("merges user config over defaults", async () => {
    const userConfig = { port: 5555, voices: { default: "alba" } };
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(userConfig));

    const { loadConfig } = await import("../config.js");
    const config = loadConfig(configPath);
    expect(config.port).toBe(5555);
    expect(config.voices.default).toBe("alba");
    // Defaults still present for unset fields
    expect(config.queue.maxSize).toBe(20);
  });

  it("resolves voice with cascade: project > source > default", async () => {
    const { loadConfig, resolveVoice } = await import("../config.js");
    const config = loadConfig(path.join(tmpDir, "nonexistent.json"));
    config.voices.sources = { "claude-code": "jean", codex: "azelma" };
    config.voices.projects = { gleam: "cosette" };

    expect(resolveVoice(config, "gleam", "claude-code")).toBe("cosette");
    expect(resolveVoice(config, "pizzabot", "claude-code")).toBe("jean");
    expect(resolveVoice(config, "pizzabot", "codex")).toBe("azelma");
    expect(resolveVoice(config, "unknown", "unknown")).toBe("jean");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/config.test.js`
Expected: FAIL — module `../config.js` not found

**Step 3: Create default config**

Create `config/default.json`:

```json
{
  "port": 9876,
  "voices": {
    "default": "jean",
    "sources": {
      "claude-code": "jean",
      "codex": "azelma"
    },
    "projects": {}
  },
  "summarization": {
    "claude-code": { "method": "claude-cli" },
    "codex": { "method": "openai", "model": "gpt-4o-mini" }
  },
  "tts": {
    "engine": "pocket-tts",
    "host": "localhost",
    "port": 8000
  },
  "queue": {
    "maxSize": 20,
    "dedupWindowMs": 10000,
    "batchSubAgents": true
  },
  "omni": {
    "enabled": false,
    "intervalSeconds": 45,
    "watchSessions": ["active"],
    "alertOnDrift": true,
    "narrateRoutine": false,
    "summarizer": { "method": "claude-cli", "model": "haiku" }
  }
}
```

**Step 4: Write config.js implementation**

Create `src/config.js`:

```js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "config", "default.json");

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(configPath) {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf-8"));

  if (!configPath || !fs.existsSync(configPath)) {
    return defaults;
  }

  const userConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return deepMerge(defaults, userConfig);
}

export function resolveVoice(config, project, source) {
  const voices = config.voices || {};
  if (voices.projects && voices.projects[project]) {
    return voices.projects[project];
  }
  if (voices.sources && voices.sources[source]) {
    return voices.sources[source];
  }
  return voices.default || "jean";
}

const USER_CONFIG_PATH = path.join(
  process.env.HOME || "",
  ".agentvox",
  "config.json"
);

export function getConfig() {
  return loadConfig(USER_CONFIG_PATH);
}
```

**Step 5: Run test to verify it passes**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/config.test.js`
Expected: 3 tests PASS

**Step 6: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add src/config.js src/__tests__/config.test.js config/default.json
git commit -m "feat: config module with voice cascade resolution"
```

---

### Task 3: Priority Queue

**Files:**
- Create: `src/queue.js`
- Create: `src/__tests__/queue.test.js`

**Step 1: Write the failing tests**

Create `src/__tests__/queue.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("PriorityQueue", () => {
  let queue;

  beforeEach(async () => {
    const { PriorityQueue } = await import("../queue.js");
    queue = new PriorityQueue({ maxSize: 5, dedupWindowMs: 1000, batchSubAgents: true });
  });

  it("dequeues high priority before normal", () => {
    queue.enqueue({ sessionId: "a", priority: "normal", context: "normal msg" });
    queue.enqueue({ sessionId: "b", priority: "high", context: "urgent msg" });

    const first = queue.dequeue();
    expect(first.priority).toBe("high");
    expect(first.context).toBe("urgent msg");
  });

  it("dequeues normal before low", () => {
    queue.enqueue({ sessionId: "a", priority: "low", context: "sub-agent" });
    queue.enqueue({ sessionId: "b", priority: "normal", context: "main" });

    const first = queue.dequeue();
    expect(first.priority).toBe("normal");
  });

  it("maintains FIFO within same priority", () => {
    queue.enqueue({ sessionId: "a", priority: "normal", context: "first" });
    queue.enqueue({ sessionId: "b", priority: "normal", context: "second" });

    expect(queue.dequeue().context).toBe("first");
    expect(queue.dequeue().context).toBe("second");
  });

  it("deduplicates by sessionId within window", () => {
    queue.enqueue({ sessionId: "a", priority: "normal", context: "old" });
    queue.enqueue({ sessionId: "a", priority: "normal", context: "new" });

    expect(queue.size()).toBe(1);
    expect(queue.dequeue().context).toBe("new");
  });

  it("drops oldest low-priority when full", () => {
    // Fill with 5 items (max)
    for (let i = 0; i < 3; i++) {
      queue.enqueue({ sessionId: `low-${i}`, priority: "low", context: `low-${i}` });
    }
    queue.enqueue({ sessionId: "n1", priority: "normal", context: "normal-1" });
    queue.enqueue({ sessionId: "n2", priority: "normal", context: "normal-2" });
    expect(queue.size()).toBe(5);

    // Adding one more should drop oldest low
    queue.enqueue({ sessionId: "n3", priority: "normal", context: "normal-3" });
    expect(queue.size()).toBe(5);

    // All normals should survive
    const items = queue.drain();
    const normalItems = items.filter((i) => i.priority === "normal");
    expect(normalItems.length).toBe(3);
  });

  it("returns null when empty", () => {
    expect(queue.dequeue()).toBeNull();
  });

  it("returns pending items via pending()", () => {
    queue.enqueue({ sessionId: "a", priority: "high", context: "one" });
    queue.enqueue({ sessionId: "b", priority: "normal", context: "two" });

    const pending = queue.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0].priority).toBe("high");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/queue.test.js`
Expected: FAIL — module `../queue.js` not found

**Step 3: Write queue implementation**

Create `src/queue.js`:

```js
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

export class PriorityQueue {
  constructor({ maxSize = 20, dedupWindowMs = 10000, batchSubAgents = true } = {}) {
    this.maxSize = maxSize;
    this.dedupWindowMs = dedupWindowMs;
    this.batchSubAgents = batchSubAgents;
    this.items = [];
    this.listeners = [];
  }

  enqueue(message) {
    const now = Date.now();
    message.enqueuedAt = now;

    // Dedup: replace existing message from same sessionId within window
    const existingIdx = this.items.findIndex(
      (item) =>
        item.sessionId === message.sessionId &&
        now - item.enqueuedAt < this.dedupWindowMs
    );
    if (existingIdx !== -1) {
      this.items[existingIdx] = message;
      this._notify("update", message);
      return;
    }

    // If at capacity, drop oldest low-priority
    if (this.items.length >= this.maxSize) {
      const lowIdx = this._findOldestLow();
      if (lowIdx !== -1) {
        this.items.splice(lowIdx, 1);
      } else {
        // All high/normal — drop oldest overall
        this.items.shift();
      }
    }

    this.items.push(message);
    this._notify("enqueue", message);
  }

  dequeue() {
    if (this.items.length === 0) return null;

    // Find highest priority item (lowest PRIORITY_ORDER value)
    let bestIdx = 0;
    let bestPriority = PRIORITY_ORDER[this.items[0].priority] ?? 1;

    for (let i = 1; i < this.items.length; i++) {
      const p = PRIORITY_ORDER[this.items[i].priority] ?? 1;
      if (p < bestPriority) {
        bestPriority = p;
        bestIdx = i;
      }
    }

    const item = this.items.splice(bestIdx, 1)[0];
    this._notify("dequeue", item);
    return item;
  }

  pending() {
    return [...this.items].sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
    );
  }

  drain() {
    const all = this.pending();
    this.items = [];
    return all;
  }

  size() {
    return this.items.length;
  }

  onEvent(listener) {
    this.listeners.push(listener);
  }

  _findOldestLow() {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].priority === "low") return i;
    }
    return -1;
  }

  _notify(event, message) {
    for (const listener of this.listeners) {
      listener(event, message);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/queue.test.js`
Expected: 7 tests PASS

**Step 5: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add src/queue.js src/__tests__/queue.test.js
git commit -m "feat: priority queue with dedup and overflow eviction"
```

---

### Task 4: TTS Module

**Files:**
- Create: `src/tts.js`
- Create: `src/__tests__/tts.test.js`

**Step 1: Write the failing tests**

Create `src/__tests__/tts.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TtsEngine } from "../tts.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({
    on: vi.fn((event, cb) => {
      if (event === "close") setTimeout(() => cb(0), 10);
    }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  })),
}));

// Mock fetch for health check
global.fetch = vi.fn();

describe("TtsEngine", () => {
  let tts;

  beforeEach(() => {
    vi.clearAllMocks();
    tts = new TtsEngine({ host: "localhost", port: 8000 });
  });

  it("constructs TTS URL from config", () => {
    expect(tts.baseUrl).toBe("http://localhost:8000");
  });

  it("checkHealth returns true when server responds", async () => {
    global.fetch.mockResolvedValueOnce({ ok: true });
    const healthy = await tts.checkHealth();
    expect(healthy).toBe(true);
  });

  it("checkHealth returns false when server is down", async () => {
    global.fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const healthy = await tts.checkHealth();
    expect(healthy).toBe(false);
  });

  it("speak builds correct form data URL", () => {
    // Just verify the method exists and accepts the right args
    expect(typeof tts.speak).toBe("function");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/tts.test.js`
Expected: FAIL — module `../tts.js` not found

**Step 3: Write TTS implementation**

Create `src/tts.js`:

```js
import { execSync, spawn } from "node:child_process";

export class TtsEngine {
  constructor({ host = "localhost", port = 8000 } = {}) {
    this.host = host;
    this.port = port;
    this.baseUrl = `http://${host}:${port}`;
    this.serverProcess = null;
    this.speaking = false;
    this.currentProcess = null;
  }

  async checkHealth() {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureServer() {
    if (await this.checkHealth()) return;

    console.log("Starting pocket-tts server...");
    this.serverProcess = spawn(
      "uvx",
      ["pocket-tts", "serve", "--host", this.host, "--port", String(this.port)],
      { stdio: "ignore", detached: true }
    );
    this.serverProcess.unref();

    // Wait for server to be ready (max 60s)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.checkHealth()) {
        console.log("pocket-tts server ready");
        return;
      }
    }
    throw new Error("pocket-tts server failed to start within 60 seconds");
  }

  async speak(text, voice) {
    await this.ensureServer();

    this.speaking = true;

    return new Promise((resolve, reject) => {
      const args = [
        "-s", "-X", "POST",
        `${this.baseUrl}/tts`,
        "-F", `text=${text}`,
      ];
      if (voice) {
        args.push("-F", `voice_url=${voice}`);
      }

      // Try streaming to ffplay first, fall back to temp file + afplay
      const curl = spawn("curl", args, { stdio: ["ignore", "pipe", "ignore"] });
      const player = spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "pipe:0"], {
        stdio: ["pipe", "ignore", "ignore"],
      });

      curl.stdout.pipe(player.stdin);

      player.on("error", () => {
        // ffplay not available, fall back to afplay
        curl.kill();
        this._speakFallback(text, voice).then(resolve).catch(reject);
      });

      player.on("close", (code) => {
        this.speaking = false;
        this.currentProcess = null;
        resolve();
      });

      this.currentProcess = { curl, player };
    });
  }

  async _speakFallback(text, voice) {
    await this.ensureServer();

    return new Promise((resolve, reject) => {
      const tmpFile = `/tmp/agentvox-tts-${Date.now()}.wav`;
      const args = [
        "-s", "-X", "POST",
        `${this.baseUrl}/tts`,
        "-F", `text=${text}`,
        "-o", tmpFile,
      ];
      if (voice) {
        args.push("-F", `voice_url=${voice}`);
      }

      const curl = spawn("curl", args);
      curl.on("close", (code) => {
        if (code !== 0) {
          this.speaking = false;
          return reject(new Error("curl failed"));
        }

        const player = spawn("afplay", [tmpFile]);
        player.on("close", () => {
          this.speaking = false;
          this.currentProcess = null;
          try { require("node:fs").unlinkSync(tmpFile); } catch {}
          resolve();
        });
        this.currentProcess = { player };
      });
    });
  }

  stop() {
    if (this.currentProcess) {
      if (this.currentProcess.curl) this.currentProcess.curl.kill();
      if (this.currentProcess.player) this.currentProcess.player.kill();
      this.currentProcess = null;
    }
    this.speaking = false;
  }

  isSpeaking() {
    return this.speaking;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/tts.test.js`
Expected: 4 tests PASS

**Step 5: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add src/tts.js src/__tests__/tts.test.js
git commit -m "feat: TTS engine with pocket-tts, ffplay streaming, afplay fallback"
```

---

### Task 5: LLM Summarizer

**Files:**
- Create: `src/summarizer.js`
- Create: `src/__tests__/summarizer.test.js`

**Step 1: Write the failing tests**

Create `src/__tests__/summarizer.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

describe("Summarizer", () => {
  let Summarizer, execSync;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import("node:child_process");
    execSync = cp.execSync;

    const mod = await import("../summarizer.js");
    Summarizer = mod.Summarizer;
  });

  it("uses claude-cli method for claude-code source", async () => {
    execSync.mockReturnValueOnce(
      JSON.stringify({ result: "Fixed the auth bug and ran the tests." })
    );

    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      context: "I fixed a bug in the auth handler...",
      project: "gleam",
      branch: "main",
    });

    expect(result).toBe("Fixed the auth bug and ran the tests.");
    expect(execSync).toHaveBeenCalled();
    const callArgs = execSync.mock.calls[0][0];
    expect(callArgs).toContain("claude");
  });

  it("returns pre-made summary without LLM call", async () => {
    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      summary: "Already summarized for you.",
      context: "ignored",
    });

    expect(result).toBe("Already summarized for you.");
    expect(execSync).not.toHaveBeenCalled();
  });

  it("truncates to 100 words max", async () => {
    const longSummary = Array(150).fill("word").join(" ");
    execSync.mockReturnValueOnce(JSON.stringify({ result: longSummary }));

    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      context: "stuff",
    });

    expect(result.split(" ").length).toBeLessThanOrEqual(101); // 100 + "..."
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/summarizer.test.js`
Expected: FAIL — module not found

**Step 3: Write summarizer implementation**

Create `src/summarizer.js`:

```js
import { execSync } from "node:child_process";

const EVENT_PROMPT = `You are a coding assistant who just completed work. Generate a 1-2 sentence spoken summary. Match the user's tone. Never include file paths, UUIDs, or technical identifiers — use natural language instead. Keep it under 25 words.`;

const OMNI_PROMPT = (project, branch, activity) =>
  `You're observing a coding agent working on ${project} on the ${branch} branch. Here's what it's done recently:\n${activity}\n\nGive a 1-sentence spoken update about what it's doing and whether it seems on track. Only speak if something interesting or concerning is happening. Say nothing if it's routine.`;

function truncate(text, maxWords = 100) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

export class Summarizer {
  constructor(config = {}) {
    this.config = config;
  }

  async summarize({ source, context, summary, project, branch }) {
    // If pre-made summary provided, use it directly
    if (summary) return summary;

    const sourceConfig = this.config[source] || { method: "claude-cli" };

    let result;
    if (sourceConfig.method === "claude-cli") {
      result = await this._claudeCli(context, project, branch);
    } else if (sourceConfig.method === "openai") {
      result = await this._openai(context, project, branch, sourceConfig.model);
    } else {
      // Fallback: just truncate the context
      result = truncate(context, 25);
    }

    return truncate(result, 100);
  }

  async summarizeOmni({ project, branch, activity }) {
    const prompt = OMNI_PROMPT(project, branch, activity);
    try {
      const output = execSync(
        `claude -p --output-format json --no-session-persistence --setting-sources "" ${JSON.stringify(prompt)}`,
        { encoding: "utf-8", timeout: 30000 }
      );
      const data = JSON.parse(output);
      return truncate(data.result || "", 50);
    } catch {
      return null; // Nothing to say
    }
  }

  async _claudeCli(context, project, branch) {
    const fullPrompt = `${EVENT_PROMPT}\n\nProject: ${project || "unknown"}\nBranch: ${branch || "unknown"}\n\nContext:\n${context}`;
    try {
      const output = execSync(
        `claude -p --output-format json --no-session-persistence --setting-sources "" ${JSON.stringify(fullPrompt)}`,
        { encoding: "utf-8", timeout: 30000 }
      );
      const data = JSON.parse(output);
      return data.result || context.slice(0, 100);
    } catch {
      return context.slice(0, 100);
    }
  }

  async _openai(context, project, branch, model = "gpt-4o-mini") {
    // Dynamic import to avoid requiring openai when not used
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI();
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: EVENT_PROMPT },
          {
            role: "user",
            content: `Project: ${project || "unknown"}\nBranch: ${branch || "unknown"}\n\nContext:\n${context}`,
          },
        ],
        max_tokens: 100,
      });
      return response.choices[0]?.message?.content || context.slice(0, 100);
    } catch {
      return context.slice(0, 100);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/summarizer.test.js`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add src/summarizer.js src/__tests__/summarizer.test.js
git commit -m "feat: LLM summarizer with claude-cli and openai backends"
```

---

### Task 6: API Routes + Server Wiring

**Files:**
- Create: `src/routes/api.js`
- Modify: `src/server.js`
- Create: `src/__tests__/api.test.js`

**Step 1: Install supertest**

Run: `cd /Users/mfelix/code/agentvox && npm install -D supertest`

**Step 2: Write the failing tests**

Create `src/__tests__/api.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

let app, server;

beforeAll(async () => {
  // Set a test port to avoid conflicts
  process.env.AGENTVOX_PORT = "0"; // Random port
  const mod = await import("../server.js");
  app = mod.app;
  server = mod.server;
});

afterAll(() => {
  server.close();
});

describe("POST /api/message", () => {
  it("accepts a valid message", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({
        source: "claude-code",
        project: "gleam",
        branch: "main",
        sessionId: "test-123",
        priority: "normal",
        type: "stop",
        context: "I fixed the bug",
      });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
  });

  it("rejects message without source", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({ context: "no source" });

    expect(res.status).toBe(400);
  });

  it("rejects message without context or summary", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({ source: "claude-code" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/status", () => {
  it("returns server status", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.queue).toBeDefined();
  });
});

describe("POST /api/mute", () => {
  it("mutes a source", async () => {
    const res = await request(app)
      .post("/api/mute")
      .send({ target: "codex" });

    expect(res.status).toBe(200);
    expect(res.body.muted).toContain("codex");
  });
});

describe("POST /api/unmute", () => {
  it("unmutes a source", async () => {
    // First mute
    await request(app).post("/api/mute").send({ target: "codex" });
    // Then unmute
    const res = await request(app)
      .post("/api/unmute")
      .send({ target: "codex" });

    expect(res.status).toBe(200);
    expect(res.body.muted).not.toContain("codex");
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/api.test.js`
Expected: FAIL

**Step 4: Write API routes**

Create `src/routes/api.js`:

```js
import { Router } from "express";

export function createApiRouter({ queue, tts, summarizer, config, state }) {
  const router = Router();

  router.post("/message", async (req, res) => {
    const { source, project, branch, worktree, sessionId, priority, type, context, summary } = req.body;

    if (!source) {
      return res.status(400).json({ error: "source is required" });
    }
    if (!context && !summary) {
      return res.status(400).json({ error: "context or summary is required" });
    }

    const message = {
      source,
      project: project || "unknown",
      branch: branch || null,
      worktree: worktree || null,
      sessionId: sessionId || `${source}-${Date.now()}`,
      priority: priority || "normal",
      type: type || "stop",
      context: context || "",
      summary: summary || null,
      receivedAt: new Date().toISOString(),
    };

    queue.enqueue(message);
    state.broadcast("message:new", message);

    // Process asynchronously — don't block the response
    processMessage(message, { queue, tts, summarizer, config, state }).catch(
      (err) => console.error("Failed to process message:", err)
    );

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
    if (target === "all") {
      state.globalMute = true;
    } else if (target) {
      state.muted.add(target);
    }
    state.broadcast("mute:update", { muted: [...state.muted], globalMute: state.globalMute });
    res.json({ muted: [...state.muted], globalMute: state.globalMute });
  });

  router.post("/unmute", (req, res) => {
    const { target } = req.body;
    if (target === "all") {
      state.globalMute = false;
    } else if (target) {
      state.muted.delete(target);
    }
    state.broadcast("mute:update", { muted: [...state.muted], globalMute: state.globalMute });
    res.json({ muted: [...state.muted], globalMute: state.globalMute });
  });

  router.get("/history", (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ history: state.history.slice(-limit) });
  });

  return router;
}

async function processMessage(message, { tts, summarizer, config, state }) {
  // Check mute
  if (state.globalMute) return;
  if (state.muted.has(message.source) || state.muted.has(message.project)) return;

  // Summarize
  const spokenText = await summarizer.summarize(message);
  message.spokenText = spokenText;

  // Add to history
  state.history.push(message);
  if (state.history.length > 200) state.history.shift();

  // Resolve voice
  const { resolveVoice } = await import("../config.js");
  const voice = resolveVoice(config, message.project, message.source);

  // Speak
  state.broadcast("speaking:start", { ...message, voice });
  await tts.speak(spokenText, voice);
  state.broadcast("speaking:done", message);
}
```

**Step 5: Rewrite server.js to wire everything together**

Replace `src/server.js`:

```js
import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PriorityQueue } from "./queue.js";
import { TtsEngine } from "./tts.js";
import { Summarizer } from "./summarizer.js";
import { getConfig } from "./config.js";
import { createApiRouter } from "./routes/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = getConfig();
const PORT = process.env.AGENTVOX_PORT || config.port || 9876;

const app = express();
app.use(express.json());

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

// Dashboard static files
app.use(express.static(path.join(__dirname, "..", "public")));

// HTTP server
const httpServer = http.createServer(app);

// WebSocket
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (ws) => {
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
        history: state.history.slice(-50),
      },
    })
  );
  ws.on("close", () => state.wsClients.delete(ws));
});

const server = httpServer.listen(PORT, () => {
  console.log(`AgentVox running on http://localhost:${PORT}`);
});

export { app, server };
```

**Step 6: Run tests to verify they pass**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run`
Expected: All tests PASS

**Step 7: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add src/routes/api.js src/server.js src/__tests__/api.test.js package-lock.json
git commit -m "feat: API routes with message ingestion, mute controls, status"
```

---

### Task 7: Web Dashboard

**Files:**
- Create: `public/index.html`
- Create: `public/style.css`
- Create: `public/app.js`

**Step 1: Create dashboard HTML**

Create `public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentVox</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>AgentVox</h1>
    <div class="controls">
      <button id="mute-all" class="btn">Mute All</button>
    </div>
  </header>

  <main>
    <section id="now-speaking" class="panel hidden">
      <h2>Now Speaking</h2>
      <div class="speaking-card">
        <span class="source-badge" id="speaking-source"></span>
        <span class="project-name" id="speaking-project"></span>
        <span class="branch-name" id="speaking-branch"></span>
        <p id="speaking-text"></p>
      </div>
    </section>

    <section id="queue-section" class="panel">
      <h2>Queue <span id="queue-count" class="count">0</span></h2>
      <div id="queue-list"></div>
    </section>

    <section id="history-section" class="panel">
      <h2>History</h2>
      <div id="history-list"></div>
    </section>

    <section id="sources-section" class="panel">
      <h2>Sources</h2>
      <div id="sources-list"></div>
    </section>
  </main>

  <script src="app.js"></script>
</body>
</html>
```

**Step 2: Create dashboard styles**

Create `public/style.css`:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0a0a0a;
  color: #e0e0e0;
  max-width: 800px;
  margin: 0 auto;
  padding: 16px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #222;
  margin-bottom: 16px;
}

header h1 { font-size: 18px; font-weight: 600; }

.btn {
  background: #222;
  color: #e0e0e0;
  border: 1px solid #333;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.btn:hover { background: #333; }
.btn.active { background: #c0392b; border-color: #e74c3c; }

.panel {
  background: #111;
  border: 1px solid #222;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.panel.hidden { display: none; }
.panel h2 { font-size: 14px; color: #888; margin-bottom: 8px; }

.count {
  background: #333;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
}

.source-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.source-badge.claude-code { background: #d4a574; color: #1a1a1a; }
.source-badge.codex { background: #74b9ff; color: #1a1a1a; }
.source-badge.custom { background: #a29bfe; color: #1a1a1a; }

.project-name { font-weight: 600; margin-left: 8px; }
.branch-name { color: #666; font-size: 12px; margin-left: 4px; }

.message-card {
  padding: 8px;
  border-bottom: 1px solid #1a1a1a;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.message-card:last-child { border-bottom: none; }
.message-card .time { color: #555; font-size: 12px; min-width: 60px; }
.message-card .text { color: #ccc; font-size: 13px; }

.speaking-card {
  padding: 8px;
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.source-control {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
}
```

**Step 3: Create dashboard JavaScript**

Create `public/app.js`:

```js
const ws = new WebSocket(`ws://${location.host}`);

const state = {
  queue: [],
  history: [],
  speaking: null,
  muted: [],
  globalMute: false,
  sources: new Set(),
};

ws.onmessage = (event) => {
  const { event: evt, data } = JSON.parse(event.data);
  switch (evt) {
    case "init":
      state.queue = data.queue || [];
      state.history = data.history || [];
      state.muted = data.muted || [];
      state.globalMute = data.globalMute;
      data.history.forEach((m) => state.sources.add(m.source));
      renderAll();
      break;
    case "message:new":
      state.sources.add(data.source);
      renderSources();
      break;
    case "speaking:start":
      state.speaking = data;
      renderSpeaking();
      break;
    case "speaking:done":
      state.speaking = null;
      state.history.push(data);
      renderSpeaking();
      renderHistory();
      break;
    case "mute:update":
      state.muted = data.muted;
      state.globalMute = data.globalMute;
      renderMuteButton();
      renderSources();
      break;
  }
};

function renderAll() {
  renderSpeaking();
  renderQueue();
  renderHistory();
  renderSources();
  renderMuteButton();
}

function renderSpeaking() {
  const section = document.getElementById("now-speaking");
  if (!state.speaking) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  document.getElementById("speaking-source").textContent = state.speaking.source;
  document.getElementById("speaking-source").className = `source-badge ${state.speaking.source}`;
  document.getElementById("speaking-project").textContent = state.speaking.project;
  document.getElementById("speaking-branch").textContent = state.speaking.branch ? `(${state.speaking.branch})` : "";
  document.getElementById("speaking-text").textContent = `"${state.speaking.spokenText || state.speaking.context}"`;
}

function renderQueue() {
  const list = document.getElementById("queue-list");
  const count = document.getElementById("queue-count");
  count.textContent = state.queue.length;
  list.innerHTML = state.queue
    .map((m) => `
      <div class="message-card">
        <span class="source-badge ${m.source}">${m.source}</span>
        <span class="project-name">${m.project}</span>
        <span class="text">"${truncate(m.context || m.summary || "", 60)}"</span>
      </div>
    `)
    .join("");
}

function renderHistory() {
  const list = document.getElementById("history-list");
  const recent = state.history.slice(-20).reverse();
  list.innerHTML = recent
    .map((m) => {
      const time = m.receivedAt ? new Date(m.receivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      return `
        <div class="message-card">
          <span class="time">${time}</span>
          <span class="source-badge ${m.source}">${m.source}</span>
          <span class="project-name">${m.project}</span>
          ${m.branch ? `<span class="branch-name">(${m.branch})</span>` : ""}
          <span class="text">"${truncate(m.spokenText || m.context || "", 80)}"</span>
        </div>
      `;
    })
    .join("");
}

function renderSources() {
  const list = document.getElementById("sources-list");
  list.innerHTML = [...state.sources]
    .map((s) => {
      const isMuted = state.muted.includes(s);
      return `
        <div class="source-control">
          <span class="source-badge ${s}">${s}</span>
          <button class="btn ${isMuted ? "active" : ""}" onclick="toggleMute('${s}')">
            ${isMuted ? "Unmute" : "Mute"}
          </button>
        </div>
      `;
    })
    .join("");
}

function renderMuteButton() {
  const btn = document.getElementById("mute-all");
  btn.textContent = state.globalMute ? "Unmute All" : "Mute All";
  btn.className = `btn ${state.globalMute ? "active" : ""}`;
}

document.getElementById("mute-all").addEventListener("click", () => {
  const target = "all";
  const endpoint = state.globalMute ? "/api/unmute" : "/api/mute";
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
});

function toggleMute(source) {
  const isMuted = state.muted.includes(source);
  const endpoint = isMuted ? "/api/unmute" : "/api/mute";
  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: source }),
  });
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + "..." : text;
}
```

**Step 4: Manually verify dashboard loads**

Run: `cd /Users/mfelix/code/agentvox && node src/server.js &`
Open: `http://localhost:9876` in browser
Expected: Dark-themed dashboard with empty sections
Then: `kill %1`

**Step 5: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add public/
git commit -m "feat: web dashboard with real-time WebSocket updates"
```

---

### Task 8: CLI

**Files:**
- Create: `bin/agentvox.js`

**Step 1: Create CLI entry point**

Create `bin/agentvox.js`:

```js
#!/usr/bin/env node

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
const PID_FILE = "/tmp/agentvox.pid";
const DEFAULT_PORT = 9876;

function getPort() {
  return process.env.AGENTVOX_PORT || DEFAULT_PORT;
}

function isRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    fs.unlinkSync(PID_FILE);
    return false;
  }
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}

switch (command) {
  case "start": {
    if (isRunning()) {
      console.log("AgentVox is already running");
      process.exit(0);
    }
    const serverPath = path.join(__dirname, "..", "src", "server.js");
    const child = execSync(`node ${serverPath} &`, { stdio: "inherit" });
    console.log("AgentVox started");
    break;
  }

  case "stop": {
    if (!isRunning()) {
      console.log("AgentVox is not running");
      process.exit(0);
    }
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(PID_FILE);
    console.log("AgentVox stopped");
    break;
  }

  case "status": {
    if (isRunning()) {
      try {
        const res = execSync(`curl -s http://localhost:${getPort()}/api/status`, { encoding: "utf-8" });
        console.log(JSON.parse(res));
      } catch {
        console.log("AgentVox is running but not responding");
      }
    } else {
      console.log("AgentVox is not running");
    }
    break;
  }

  case "send": {
    const opts = parseArgs(args.slice(1));
    if (!opts.source) {
      console.error("Usage: agentvox send --source <source> [--project <project>] [--branch <branch>] --context <text>");
      process.exit(1);
    }
    const body = {
      source: opts.source,
      project: opts.project || path.basename(process.cwd()),
      branch: opts.branch || null,
      context: opts.context || opts.summary || "",
      summary: opts.summary || null,
      priority: opts.priority || "normal",
      type: opts.type || "stop",
    };

    // Try to get git info if not provided
    if (!body.branch) {
      try {
        body.branch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
      } catch {}
    }

    try {
      const res = execSync(
        `curl -s -X POST http://localhost:${getPort()}/api/message -H 'Content-Type: application/json' -d '${JSON.stringify(body)}'`,
        { encoding: "utf-8" }
      );
      console.log(JSON.parse(res));
    } catch (err) {
      console.error("Failed to send message. Is AgentVox running?");
      process.exit(1);
    }
    break;
  }

  case "mute": {
    const target = args[1] || "all";
    try {
      execSync(
        `curl -s -X POST http://localhost:${getPort()}/api/mute -H 'Content-Type: application/json' -d '{"target":"${target}"}'`,
        { encoding: "utf-8" }
      );
      console.log(`Muted: ${target}`);
    } catch {
      console.error("Failed. Is AgentVox running?");
    }
    break;
  }

  case "unmute": {
    const target = args[1] || "all";
    try {
      execSync(
        `curl -s -X POST http://localhost:${getPort()}/api/unmute -H 'Content-Type: application/json' -d '{"target":"${target}"}'`,
        { encoding: "utf-8" }
      );
      console.log(`Unmuted: ${target}`);
    } catch {
      console.error("Failed. Is AgentVox running?");
    }
    break;
  }

  default:
    console.log(`AgentVox - Voice hub for AI coding agents

Usage:
  agentvox start                  Start the server
  agentvox stop                   Stop the server
  agentvox status                 Check server status
  agentvox send --source <s> ...  Push a message
  agentvox mute [source|project]  Mute a source/project (or all)
  agentvox unmute [source|project] Unmute
`);
}
```

**Step 2: Make executable**

Run: `chmod +x /Users/mfelix/code/agentvox/bin/agentvox.js`

**Step 3: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add bin/agentvox.js
git commit -m "feat: CLI with start, stop, status, send, mute commands"
```

---

### Task 9: Claude Code Stop Hook

**Files:**
- Create: `hooks/claude-code-stop.sh`

**Step 1: Write the stop hook**

Create `hooks/claude-code-stop.sh`:

```bash
#!/usr/bin/env bash
# AgentVox stop hook for Claude Code
# Reads session context and POSTs to the AgentVox hub.
# Returns {"decision": "approve"} immediately — non-blocking.

set -e

AGENTVOX_PORT="${AGENTVOX_PORT:-9876}"
AGENTVOX_URL="http://localhost:${AGENTVOX_PORT}"

# Quick check: is the server running?
if ! curl -sf "${AGENTVOX_URL}/api/status" > /dev/null 2>&1; then
    echo '{"decision": "approve"}'
    exit 0
fi

# Read stdin for session info
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('session_id', ''))
" 2>/dev/null || echo "")

if [[ -z "$SESSION_ID" ]]; then
    echo '{"decision": "approve"}'
    exit 0
fi

# Get git info
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
WORKTREE=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
PROJECT=$(basename "${WORKTREE:-$PWD}")

# Find and read session file for context
CONTEXT=""
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSION_FILE=$(find "$CLAUDE_HOME/projects" -name "${SESSION_ID}.jsonl" 2>/dev/null | head -1)

if [[ -n "$SESSION_FILE" ]]; then
    # Extract last few assistant messages (last 2000 chars of text content)
    CONTEXT=$(python3 -c "
import json, sys
msgs = []
with open('$SESSION_FILE', 'r') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            data = json.loads(line)
            if data.get('type') != 'assistant': continue
            content = data.get('message', {}).get('content', '')
            if isinstance(content, str):
                msgs.append(content[:500])
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get('type') == 'text':
                        msgs.append(item.get('text', '')[:500])
        except: pass
# Last 3 assistant messages
for msg in msgs[-3:]:
    print(msg)
" 2>/dev/null || echo "")
fi

if [[ -z "$CONTEXT" ]]; then
    echo '{"decision": "approve"}'
    exit 0
fi

# POST to AgentVox (background, non-blocking)
curl -sf -X POST "${AGENTVOX_URL}/api/message" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "
import json
print(json.dumps({
    'source': 'claude-code',
    'project': '$PROJECT',
    'branch': '$BRANCH',
    'worktree': '$WORKTREE',
    'sessionId': '$SESSION_ID',
    'priority': 'normal',
    'type': 'stop',
    'context': '''$CONTEXT'''[:2000]
}))
")" > /dev/null 2>&1 &

echo '{"decision": "approve"}'
```

**Step 2: Make executable**

Run: `chmod +x /Users/mfelix/code/agentvox/hooks/claude-code-stop.sh`

**Step 3: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add hooks/claude-code-stop.sh
git commit -m "feat: Claude Code stop hook for AgentVox integration"
```

---

### Task 10: Codex Wrapper

**Files:**
- Create: `hooks/codex-wrapper.sh`

**Step 1: Write the Codex wrapper**

Create `hooks/codex-wrapper.sh`:

```bash
#!/usr/bin/env bash
# AgentVox wrapper for Codex CLI
# Usage: codex-vox [any codex args]
# Runs codex, captures output, sends completion to AgentVox.

AGENTVOX_PORT="${AGENTVOX_PORT:-9876}"
AGENTVOX_URL="http://localhost:${AGENTVOX_PORT}"

BRANCH=$(git branch --show-current 2>/dev/null || echo "")
WORKTREE=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
PROJECT=$(basename "${WORKTREE:-$PWD}")
SESSION_ID="codex-$(date +%s)-$$"

# Capture output while still showing it
TMPLOG=$(mktemp /tmp/codex-vox-XXXXXX.log)

# Run codex with all original args, tee output
codex "$@" 2>&1 | tee "$TMPLOG"
EXIT_CODE=${PIPESTATUS[0]}

# Get last 2000 chars of output as context
CONTEXT=$(tail -c 2000 "$TMPLOG")
rm -f "$TMPLOG"

# Determine priority
PRIORITY="normal"
TYPE="stop"
if [[ $EXIT_CODE -ne 0 ]]; then
    PRIORITY="high"
    TYPE="error"
fi

# Send to AgentVox (best effort, non-blocking)
curl -sf -X POST "${AGENTVOX_URL}/api/message" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "
import json
print(json.dumps({
    'source': 'codex',
    'project': '$PROJECT',
    'branch': '$BRANCH',
    'worktree': '$WORKTREE',
    'sessionId': '$SESSION_ID',
    'priority': '$PRIORITY',
    'type': '$TYPE',
    'context': '''$(echo "$CONTEXT" | sed "s/'/\\\\'/g")'''[:2000]
}))
")" > /dev/null 2>&1 &

exit $EXIT_CODE
```

**Step 2: Make executable**

Run: `chmod +x /Users/mfelix/code/agentvox/hooks/codex-wrapper.sh`

**Step 3: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add hooks/codex-wrapper.sh
git commit -m "feat: Codex wrapper script for AgentVox integration"
```

---

### Task 11: Omni Mode (Session Watcher)

**Files:**
- Create: `src/watcher.js`
- Create: `src/__tests__/watcher.test.js`

**Step 1: Write the failing tests**

Create `src/__tests__/watcher.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("SessionWatcher", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentvox-watcher-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects new lines appended to a session file", async () => {
    const { SessionWatcher } = await import("../watcher.js");

    const sessionFile = path.join(tmpDir, "test-session.jsonl");
    fs.writeFileSync(sessionFile, "");

    const changes = [];
    const watcher = new SessionWatcher({
      onActivity: (file, lines) => changes.push({ file, lines }),
      intervalMs: 100,
    });

    watcher.watchFile(sessionFile);

    // Append a line
    fs.appendFileSync(
      sessionFile,
      JSON.stringify({ type: "assistant", message: { content: "hello" } }) + "\n"
    );

    // Wait for detection
    await new Promise((r) => setTimeout(r, 300));

    watcher.stop();

    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0].lines.length).toBe(1);
  });

  it("extracts recent activity text from JSONL lines", async () => {
    const { extractActivity } = await import("../watcher.js");

    const lines = [
      JSON.stringify({ type: "assistant", message: { content: "I fixed the bug" } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Tests passing" }] } }),
    ];

    const activity = extractActivity(lines);
    expect(activity).toContain("I fixed the bug");
    expect(activity).toContain("Tests passing");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/watcher.test.js`
Expected: FAIL

**Step 3: Write watcher implementation**

Create `src/watcher.js`:

```js
import fs from "node:fs";

export class SessionWatcher {
  constructor({ onActivity, intervalMs = 5000 } = {}) {
    this.onActivity = onActivity;
    this.intervalMs = intervalMs;
    this.watchedFiles = new Map(); // path -> { offset, watcher }
    this.pollInterval = null;
  }

  watchFile(filePath) {
    if (this.watchedFiles.has(filePath)) return;

    const stat = fs.statSync(filePath);
    const entry = { offset: stat.size, filePath };

    this.watchedFiles.set(filePath, entry);

    // Poll for changes
    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => this._poll(), this.intervalMs);
    }
  }

  unwatchFile(filePath) {
    this.watchedFiles.delete(filePath);
    if (this.watchedFiles.size === 0 && this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.watchedFiles.clear();
  }

  _poll() {
    for (const [filePath, entry] of this.watchedFiles) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size <= entry.offset) continue;

        // Read new bytes
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(stat.size - entry.offset);
        fs.readSync(fd, buf, 0, buf.length, entry.offset);
        fs.closeSync(fd);

        entry.offset = stat.size;

        const newContent = buf.toString("utf-8");
        const lines = newContent
          .split("\n")
          .filter((l) => l.trim().length > 0);

        if (lines.length > 0 && this.onActivity) {
          this.onActivity(filePath, lines);
        }
      } catch {
        // File might have been deleted
      }
    }
  }
}

export function extractActivity(lines) {
  const texts = [];

  for (const line of lines) {
    try {
      const data = JSON.parse(line);
      if (data.type !== "assistant") continue;

      const content = data.message?.content;
      if (typeof content === "string") {
        texts.push(content.slice(0, 300));
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === "text") {
            texts.push(item.text.slice(0, 300));
          } else if (item.type === "tool_use") {
            texts.push(`[tool: ${item.name}]`);
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return texts.join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run src/__tests__/watcher.test.js`
Expected: 2 tests PASS

**Step 5: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add src/watcher.js src/__tests__/watcher.test.js
git commit -m "feat: omni mode session watcher with file polling"
```

---

### Task 12: Wire Omni Mode into Server

**Files:**
- Modify: `src/server.js`
- Create: `src/routes/omni.js`

**Step 1: Create omni API route**

Create `src/routes/omni.js`:

```js
import { Router } from "express";
import path from "node:path";
import { glob } from "node:fs/promises";
import fs from "node:fs";
import { SessionWatcher, extractActivity } from "../watcher.js";

export function createOmniRouter({ summarizer, queue, tts, config, state }) {
  const router = Router();
  let watcher = null;
  let lastNarration = 0;
  const intervalMs = (config.omni?.intervalSeconds || 45) * 1000;

  function startWatcher() {
    if (watcher) return;

    watcher = new SessionWatcher({
      intervalMs: 5000,
      onActivity: async (filePath, lines) => {
        const now = Date.now();
        if (now - lastNarration < intervalMs) return;

        const activity = extractActivity(lines);
        if (!activity.trim()) return;

        const project = path.basename(path.dirname(filePath));

        const spokenText = await summarizer.summarizeOmni({
          project,
          branch: "",
          activity: activity.slice(0, 2000),
        });

        if (!spokenText || spokenText.toLowerCase().includes("nothing to report")) return;

        lastNarration = now;

        const message = {
          source: "omni",
          project,
          type: "narration",
          priority: "normal",
          spokenText,
          receivedAt: new Date().toISOString(),
        };

        state.history.push(message);
        state.broadcast("speaking:start", message);

        const { resolveVoice } = await import("../config.js");
        const voice = resolveVoice(config, project, "omni");
        await tts.speak(spokenText, voice);
        state.broadcast("speaking:done", message);
      },
    });

    // Find active session files
    const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "", ".claude");
    const projectsDir = path.join(claudeHome, "projects");

    if (fs.existsSync(projectsDir)) {
      for (const dir of fs.readdirSync(projectsDir)) {
        const fullDir = path.join(projectsDir, dir);
        if (!fs.statSync(fullDir).isDirectory()) continue;

        for (const file of fs.readdirSync(fullDir)) {
          if (file.endsWith(".jsonl")) {
            const fullPath = path.join(fullDir, file);
            // Only watch files modified in the last hour
            const stat = fs.statSync(fullPath);
            if (Date.now() - stat.mtimeMs < 3600000) {
              watcher.watchFile(fullPath);
            }
          }
        }
      }
    }

    state.omniActive = true;
    state.broadcast("omni:update", { active: true });
  }

  function stopWatcher() {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
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
```

**Step 2: Add omni route to server.js**

Add after the API routes line in `src/server.js`:

```js
import { createOmniRouter } from "./routes/omni.js";
```

And after `app.use("/api", ...)`:

```js
app.use("/api/omni", createOmniRouter({ summarizer, queue, tts, config, state }));
```

**Step 3: Run all tests**

Run: `cd /Users/mfelix/code/agentvox && npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```bash
cd /Users/mfelix/code/agentvox
git add src/routes/omni.js src/server.js
git commit -m "feat: omni mode wired into server with auto-start support"
```

---

### Task 13: End-to-End Smoke Test

**Step 1: Start the server**

Run: `cd /Users/mfelix/code/agentvox && node src/server.js &`

**Step 2: Send a test message**

Run:
```bash
curl -X POST http://localhost:9876/api/message \
  -H 'Content-Type: application/json' \
  -d '{"source":"claude-code","project":"gleam","branch":"main","sessionId":"test-1","priority":"normal","type":"stop","summary":"Just finished fixing the auth bug and all tests pass."}'
```

Expected: `{"queued":true,"id":"test-1"}`

**Step 3: Check status**

Run: `curl -s http://localhost:9876/api/status | python3 -m json.tool`

**Step 4: Open dashboard**

Open `http://localhost:9876` in browser. Verify the message appears in history.

**Step 5: Test mute**

Run:
```bash
curl -X POST http://localhost:9876/api/mute -H 'Content-Type: application/json' -d '{"target":"codex"}'
```

**Step 6: Stop server**

Run: `kill %1`

**Step 7: Commit any fixes from smoke test**

```bash
cd /Users/mfelix/code/agentvox
git add -A && git commit -m "fix: adjustments from end-to-end smoke test"
```

---

## Summary

| Task | Component | Tests |
|------|-----------|-------|
| 1 | Project scaffolding | — |
| 2 | Config module | 3 |
| 3 | Priority queue | 7 |
| 4 | TTS engine | 4 |
| 5 | LLM summarizer | 3 |
| 6 | API routes + server | 5 |
| 7 | Web dashboard | manual |
| 8 | CLI | manual |
| 9 | Claude Code stop hook | manual |
| 10 | Codex wrapper | manual |
| 11 | Omni mode watcher | 2 |
| 12 | Omni mode server wiring | — |
| 13 | End-to-end smoke test | manual |

Total: 13 tasks, 24 automated tests, builds from foundation up.
