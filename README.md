# AgentVox

A centralized voice notification and narration hub for AI coding agents. Hear what Claude Code and Codex are doing across all your projects — without them talking over each other.

AgentVox summarizes agent activity using an LLM, speaks it aloud through a local TTS engine, and shows everything in a real-time web dashboard.

## Prerequisites

- **Node.js** v18+
- **FFmpeg** (streaming audio playback via `ffplay`; falls back to `afplay` on macOS)
- **uv** (Python package runner — used to auto-launch [pocket-tts](https://github.com/nicholasgasior/pocket-tts))
- **Claude Code CLI** (`claude`) — used for LLM summarization (default method)

```bash
# macOS
brew install ffmpeg uv

# Verify
node --version   # v18+
ffplay -version  # from ffmpeg
uvx --version    # from uv
claude --version # Claude Code CLI
```

Optional: if you configure OpenAI-based summarization for a source, you'll need the `openai` npm package and an `OPENAI_API_KEY` environment variable.

## Quick Start

### 1. Install dependencies

```bash
git clone <repo-url> ~/code/agentvox
cd ~/code/agentvox
npm install
```

### 2. Start the server

```bash
node src/server.js
```

You should see: `AgentVox running on http://localhost:9876`

On the first TTS request, pocket-tts will auto-start via `uvx` and download a voice model (~100 MB). This takes 30-60 seconds the first time only.

### 3. Open the dashboard

Navigate to **http://localhost:9876** in your browser.

The dashboard shows real-time updates over WebSocket: now-speaking indicator, message queue, history, and per-source/project controls.

### 4. Send a test message

```bash
# Pre-made summary (no LLM call needed)
curl -X POST http://localhost:9876/api/message \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "claude-code",
    "project": "myapp",
    "branch": "main",
    "summary": "Fixed the authentication bug and all tests are passing now."
  }'

# Raw context (triggers LLM summarization + TTS)
curl -X POST http://localhost:9876/api/message \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "claude-code",
    "project": "myapp",
    "branch": "main",
    "context": "Refactored the auth module to use JWT tokens. Updated middleware, added token refresh, wrote 12 new tests."
  }'
```

## CLI

Link the CLI globally (one time):

```bash
cd ~/code/agentvox && npm link
```

Then use from anywhere:

```bash
agentvox start                     # Start server in background
agentvox stop                      # Stop server
agentvox status                    # Check server status & queue
agentvox send --source claude-code --project myapp --context "Just finished the refactor"
agentvox mute codex                # Mute a source or project
agentvox unmute codex              # Unmute
agentvox mute                      # Mute all
agentvox unmute                    # Unmute all
agentvox omni on                   # Enable omni mode (live narration)
agentvox omni off                  # Disable omni mode
```

The server runs as a detached background process. PID is stored at `/tmp/agentvox.pid`.

## Integrating with Claude Code

Add this to your project's `.claude/settings.json` (or global `~/.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/code/agentvox/hooks/claude-code-stop.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Every time Claude Code finishes a turn, the hook reads the session transcript, sends the last few assistant messages to AgentVox, where they get summarized and spoken aloud.

## Integrating with Codex

Use the wrapper script instead of calling `codex` directly:

```bash
bash ~/code/agentvox/hooks/codex-wrapper.sh "fix the bug"

# Or alias it
alias codex-vox='bash ~/code/agentvox/hooks/codex-wrapper.sh'
codex-vox "fix the bug"
```

The wrapper captures Codex's output and sends a completion summary to AgentVox. Errors are sent with `high` priority.

## Dashboard Features

The web dashboard at `http://localhost:9876` provides real-time controls:

- **Now Speaking** — shows the current message being spoken with an audio waveform animation
- **Message Queue** — expandable queue bar showing pending messages, with a clear button
- **Message History** — scrollable list of recent messages with timestamps, source badges, and spoken text
- **Sources & Projects** — per-source and per-project control cards with:
  - **Voice** — select from 8 available voices (cascade: project > source > default)
  - **Speed** — playback speed slider (0.5x to 2.0x)
  - **Verbosity** — summary length (Telegraphic / Terse / Normal / Detailed / Narrative)
  - **Vibe** — tone of the summary (neutral, chill, hyped, zen, snarky)
  - **Humor** — personality level (0% to 100%)
  - **Announce** — checkbox to prepend the source name before speaking ("claude code. Fixed the auth bug...")
  - **Mute / Unmute** — silence a specific source or project
  - **Clear** — remove history for a source or project
  - **Rename** — click any source or project name to give it a custom display name
- **Omni toggle** — enable/disable live narration mode
- **Mute All** — global mute

All settings are persisted to `~/.agentvox/config.json` and sync in real time across all connected dashboard tabs via WebSocket.

## Voices

Available voices: `alba`, `marius`, `javert`, `jean`, `fantine`, `cosette`, `eponine`, `azelma`

Voices cascade: **project voice > source voice > default voice**. If a project has a voice assigned, it takes priority over the source voice.

Configure via the dashboard or directly in `~/.agentvox/config.json`:

```json
{
  "voices": {
    "default": "jean",
    "sources": {
      "claude-code": "jean",
      "codex": "azelma"
    },
    "projects": {
      "myapp": "cosette"
    }
  }
}
```

## Personality System

Each source and project can have its own summarization personality. Settings cascade: **project > source > default**.

| Setting     | Range         | Description                                       |
|-------------|---------------|---------------------------------------------------|
| `verbosity` | 1-5           | Summary length (1=telegraphic ~10 words, 5=narrative ~60 words) |
| `vibe`      | string        | Tone: `neutral`, `chill`, `hyped`, `zen`, `snarky` |
| `humor`     | 0-100         | Personality level (0=pure facts, 100=maximum wit)  |
| `announceSource` | boolean  | Prepend source name before speaking               |

Configure via the dashboard sliders/dropdowns or the API:

```bash
curl -X POST http://localhost:9876/api/personality \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "source",
    "name": "claude-code",
    "personality": { "verbosity": 3, "vibe": "snarky", "humor": 75 }
  }'
```

## Omni Mode (Live Narration)

Omni mode watches your active Claude Code session files and narrates what the agent is doing in real time. It polls for new transcript lines, groups activity by project, summarizes it, and speaks it aloud.

```bash
agentvox omni on     # Enable
agentvox omni off    # Disable
```

Configure in `~/.agentvox/config.json`:

```json
{
  "omni": {
    "enabled": false,
    "intervalSeconds": 15,
    "alertOnDrift": true,
    "narrateRoutine": false
  }
}
```

- `intervalSeconds` — how often to drain the activity buffer and narrate (default: 15)
- `enabled` — auto-start omni mode when the server launches

## Configuration

AgentVox uses two config layers:

1. **`config/default.json`** — built-in defaults (do not edit)
2. **`~/.agentvox/config.json`** — user overrides (created automatically when you change settings)

User config is deep-merged on top of defaults. The full set of configurable options:

```json
{
  "port": 9876,
  "sourceNames": { "claude-code": "Claude" },
  "voices": { "default": "jean", "sources": {}, "projects": {} },
  "speed": { "default": 1.0, "sources": {}, "projects": {} },
  "personality": {
    "default": { "verbosity": 2, "vibe": "chill", "humor": 25, "announceSource": false },
    "sources": {},
    "projects": {}
  },
  "summarization": {
    "claude-code": { "method": "claude-cli" },
    "codex": { "method": "openai", "model": "gpt-4o-mini" }
  },
  "tts": { "engine": "pocket-tts", "host": "localhost", "port": 8000 },
  "queue": { "maxSize": 20, "dedupWindowMs": 10000, "batchSubAgents": true },
  "omni": { "enabled": false, "intervalSeconds": 15 }
}
```

The port can also be set via the `AGENTVOX_PORT` environment variable.

## API Reference

All endpoints accept and return JSON.

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/message` | Send a message (fields: `source` (required), `project`, `branch`, `worktree`, `sessionId`, `priority`, `type`, `context`, `summary`) |
| `GET`  | `/api/status` | Server status, queue size, speaking state |
| `GET`  | `/api/history` | Recent message history |
| `POST` | `/api/history/clear` | Clear history for a target (`{ "target": "source-or-project" }`) |
| `POST` | `/api/queue/clear` | Clear the message queue |

### Mute

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/mute` | Mute a target (`{ "target": "codex" }` or `{ "target": "all" }`) |
| `POST` | `/api/unmute` | Unmute a target |

### Voices & Speed

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/voices` | Get voice assignments |
| `POST` | `/api/voices` | Set voice (`{ "type": "source", "name": "codex", "voice": "azelma" }`) |
| `GET`  | `/api/speed` | Get speed settings |
| `POST` | `/api/speed` | Set speed (`{ "type": "source", "name": "codex", "speed": 1.5 }`) |
| `POST` | `/api/tts/preview` | Preview a voice (`{ "voice": "cosette" }`) |

### Personality

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/personality` | Get personality settings |
| `POST` | `/api/personality` | Set personality (`{ "type": "source", "name": "codex", "personality": { "vibe": "hyped" } }`) |

### Sources

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/sources/names` | Get custom source display names |
| `POST` | `/api/sources/rename` | Rename a source (`{ "source": "claude-code", "name": "Claude" }`) |

### Omni Mode

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/omni/on` | Enable omni mode |
| `POST` | `/api/omni/off` | Disable omni mode |
| `GET`  | `/api/omni/status` | Check omni mode status |

### WebSocket

Connect to `ws://localhost:9876` for real-time events. On connection, the server sends an `init` event with the full current state. Subsequent events include `message:new`, `speaking:start`, `speaking:done`, `mute:update`, `voices:update`, `speed:update`, `personality:update`, `queue:cleared`, `history:cleared`, `sources:rename`, and `omni:update`.

## Architecture

```
Coding Agents ──POST──> AgentVox Server ──> Priority Queue ──> LLM Summarizer ──> pocket-tts ──> Speaker
                              │
                              ├── WebSocket ──> Dashboard (localhost:9876)
                              └── Session Watcher (omni mode)
```

**Key modules:**

- `src/server.js` — Express + WebSocket server, shared state
- `src/routes/api.js` — REST API endpoints and message processing
- `src/routes/omni.js` — Omni mode session watcher and live narration
- `src/summarizer.js` — LLM summarization (Claude CLI or OpenAI)
- `src/tts.js` — TTS engine (pocket-tts with ffplay/afplay playback)
- `src/queue.js` — Priority queue with dedup
- `src/config.js` — Config loading, resolution cascades (voice, speed, personality)
- `public/` — Dashboard (vanilla HTML/CSS/JS with WebSocket client)
- `hooks/` — Integration scripts for Claude Code and Codex
- `bin/agentvox.js` — CLI entry point

## Running Tests

```bash
npm test          # Run all tests once
npm run test:watch  # Watch mode
```

25 tests across 6 test suites covering config, queue, TTS, summarizer, API routes, and the session watcher.

## License

MIT
