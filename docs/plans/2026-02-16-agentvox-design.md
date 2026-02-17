# AgentVox Design

A centralized voice notification and narration hub for AI coding agents.

## Problem

When you run multiple coding agents (Claude Code, Codex) across projects, you
have no unified way to hear what they're doing. The existing voice plugin only
works with Claude Code, agents talk over each other, sub-agents spam you, and
there's no way to watch an agent's progress in real time to catch it veering
off course.

## Solution

AgentVox is a local Node.js server that receives messages from any coding
agent, summarizes them with the appropriate LLM, queues them intelligently,
and speaks them through pocket-tts. It provides a web dashboard for real-time
visibility and control. It also supports an "omni mode" that actively watches
agent sessions and narrates what's happening as it works.

## Architecture

```
┌─────────────┐     POST /api/message     ┌──────────────────────────┐
│ Claude Code  │ ──────────────────────── │                          │
│ (stop hook)  │                          │   AgentVox Server        │
└─────────────┘                           │   (Node.js + Express)    │
                                          │                          │
┌─────────────┐     POST /api/message     │  ┌──────────────────┐   │     ┌─────────────┐
│ Codex CLI    │ ──────────────────────── │  │ Priority Queue   │───│────▶│ pocket-tts   │
│ (wrapper)    │                          │  └──────────────────┘   │     └─────────────┘
└─────────────┘                           │  ┌──────────────────┐   │
                                          │  │ LLM Summarizer   │   │
┌─────────────┐     fs.watch (omni)       │  └──────────────────┘   │
│ Session JSONL│ ──────────────────────── │  ┌──────────────────┐   │
│ files        │                          │  │ Session Watcher  │   │
└─────────────┘                           │  └──────────────────┘   │
                                          │  ┌──────────────────┐   │
             GET / (WebSocket)            │  │ Web Dashboard    │   │
┌─────────────┐ ◀──────────────────────── │  └──────────────────┘   │
│  Browser     │                          │                          │
└─────────────┘                           └──────────────────────────┘
```

Single Node.js process. Port 9876 by default (configurable via AGENTVOX_PORT).

## Operating Modes

### Event Mode

Agents push updates to the hub at completion. The hub summarizes and speaks.

Data flow:
1. Agent hook fires (stop hook for Claude Code, wrapper for Codex)
2. POST to `http://localhost:9876/api/message` with context
3. Hub generates 1-2 sentence summary via LLM
4. Message enters priority queue
5. Queue dequeues next message
6. pocket-tts speaks it
7. Dashboard updates via WebSocket

### Omni Mode (Live Narration)

AgentVox actively watches agent session files and narrates what's happening
in real time. The agent doesn't push — AgentVox pulls.

Data flow:
1. AgentVox watches session JSONL files via `fs.watch`
2. Buffers changes, waits for throttle interval
3. Feeds recent activity to LLM: "What is the agent doing? Is it on track?"
4. LLM generates short spoken update
5. Priority queue, TTS, dashboard update

Narration throttling heuristics:
- Minimum interval: 30-60 seconds between narrations (configurable)
- Significance detection: only narrate meaningful events (new file, test run,
  error, direction change)
- Silence on routine: skip narration for boring work (reading files, small edits)
- Alert on drift: if agent appears off-course, narrate immediately

Omni mode uses a cheaper/faster model (e.g. Haiku) since it makes frequent
LLM calls. End-of-task summaries use the beefier model.

## Message Schema

What agents POST to the hub:

```json
{
  "source": "claude-code",
  "project": "gleam",
  "branch": "feature/auth-system",
  "worktree": "/Users/mfelix/code/gleam-worktrees/auth-system",
  "sessionId": "abc-123",
  "priority": "normal",
  "type": "stop",
  "context": "...",
  "summary": null
}
```

Fields:
- `source`: Agent type ("claude-code", "codex"). Determines summarization model.
- `project`: Project/directory name for grouping and voice selection.
- `branch`: Git branch the agent is working on.
- `worktree`: Absolute path to the git worktree (if applicable).
- `sessionId`: Agent session ID for deduplication.
- `priority`: "high" (errors, completions), "normal", "low" (sub-agents).
- `type`: "stop", "error", "status", "milestone".
- `context`: Raw text/conversation context for summarization.
- `summary`: Optional pre-made summary (skips LLM call if provided).

## Priority Queue

Three tiers:
1. **High**: errors, main agent completions. Spoken immediately.
2. **Normal**: regular agent stops. FIFO within this tier.
3. **Low**: sub-agent updates. Batched and deduplicated (e.g. "3 sub-agents
   finished their tasks on the gleam project").

Deduplication: Messages from the same sessionId within 10 seconds are merged
(keeps latest).

Queue limit: Max 20 messages. Oldest low-priority messages drop first.

## Voice Resolution

Voices are assigned with a cascade — most specific wins:

Resolution order: project voice > source voice > default voice.

Example: working on "gleam" with Claude Code and gleam has voice "cosette"
configured — you hear Cosette regardless of the Claude Code default.

## LLM Summarization

Per-source model selection:
- Claude Code messages: `claude -p` (headless Claude CLI)
- Codex messages: OpenAI API (via openai npm package)
- Omni mode narration: configurable, defaults to cheaper model

Summarization prompt (event mode):
> You are a coding assistant who just completed work. Generate a 1-2 sentence
> spoken summary. Match the user's tone. Never include file paths, UUIDs, or
> technical identifiers — use natural language. Keep it under 25 words.

Narration prompt (omni mode):
> You're observing a coding agent working on [project] on the [branch] branch.
> Here's what it's done in the last 60 seconds: [activity]. Give a 1-sentence
> spoken update about what it's doing and whether it seems on track. Only speak
> if something interesting or concerning is happening.

## TTS Engine

pocket-tts (local, free, works offline).
- Runs as persistent background server via `uvx pocket-tts serve`
- Auto-started on first TTS request
- Streaming playback via ffplay (preferred) or fallback to afplay/aplay
- Available voices: alba, marius, javert, jean, fantine, cosette, eponine, azelma

## Web Dashboard

Single-page localhost web UI. Real-time updates via WebSocket.

Layout:
- Now Speaking: current TTS with progress
- Queue: pending messages
- History: scrolling log of all messages (spoken or silent)
- Per-source mute: toggle voice per agent type
- Per-project mute: toggle voice per project
- Global mute: kill all audio
- Omni mode toggle: enable/disable live narration per session
- Settings: voice selection, config panel

## Agent Integration

### Claude Code

A stop hook that:
1. Reads session JSONL for recent conversation context
2. Runs `git branch --show-current` and `git rev-parse --show-toplevel`
3. POSTs to `http://localhost:9876/api/message`
4. Returns `{"decision": "approve"}` immediately (non-blocking)

### Codex

A wrapper script (`codex-vox`) that runs Codex and monitors output, sending
updates to the hub on completion.

### Anything else

Any tool can integrate with a simple curl:
```bash
curl -X POST http://localhost:9876/api/message \
  -H 'Content-Type: application/json' \
  -d '{"source":"custom","project":"myproject","context":"Just finished"}'
```

## Configuration

Lives at `~/.agentvox/config.json`:

```json
{
  "port": 9876,
  "voices": {
    "default": "jean",
    "sources": {
      "claude-code": "jean",
      "codex": "azelma"
    },
    "projects": {
      "gleam": "cosette",
      "pizzabot": "marius"
    }
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

## Project Structure

```
code/agentvox/
  package.json
  src/
    server.js          # Express + WebSocket server, entry point
    queue.js           # Priority queue with dedup logic
    summarizer.js      # LLM summarization (claude-cli, openai)
    tts.js             # pocket-tts integration (start server, speak)
    config.js          # Config loader (~/.agentvox/config.json)
    watcher.js         # Omni mode session file watcher
    routes/
      api.js           # POST /api/message, GET /api/status
      dashboard.js     # Serves web UI
  public/
    index.html         # Dashboard SPA
    style.css
    app.js             # WebSocket client, UI logic
  hooks/
    claude-code-stop.sh    # Claude Code stop hook
    codex-wrapper.sh       # Codex wrapper script
  bin/
    agentvox               # CLI entry point
  config/
    default.json           # Default config template
```

## CLI Commands

- `agentvox start` — starts the server (+ pocket-tts on first TTS)
- `agentvox stop` — stops the server
- `agentvox send --source X --project Y --context "..."` — push a message
- `agentvox status` — check if server is running
- `agentvox mute [source|project]` — mute a source or project
- `agentvox unmute [source|project]` — unmute
- `agentvox omni [on|off]` — toggle omni mode
