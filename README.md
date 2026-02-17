# AgentVox

A centralized voice notification and narration hub for AI coding agents. Hear what Claude Code and Codex are doing across all your projects — without them talking over each other.

## Quick Start (Try It Out!)

### Prerequisites

Make sure you have these installed:

```bash
# Node.js (you already have this)
node --version

# FFmpeg (for streaming audio playback)
brew install ffmpeg

# pocket-tts (auto-installs on first use via uvx, but you need uv)
brew install uv
```

### 1. Start the server

```bash
cd ~/code/agentvox
node src/server.js
```

You should see: `AgentVox running on http://localhost:9876`

### 2. Open the dashboard

Open your browser to **http://localhost:9876**

You'll see a dark-themed dashboard with sections for Now Speaking, Queue, History, and Sources.

### 3. Send a test message

In another terminal:

```bash
# Simple test with a pre-made summary (no LLM call needed)
curl -X POST http://localhost:9876/api/message \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "claude-code",
    "project": "gleam",
    "branch": "main",
    "priority": "normal",
    "type": "stop",
    "summary": "Fixed the authentication bug and all tests are passing now."
  }'

# Try one from "codex" to see the different badge color
curl -X POST http://localhost:9876/api/message \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "codex",
    "project": "pizzabot",
    "branch": "feature/toppings",
    "priority": "normal",
    "type": "stop",
    "summary": "Added the pizza topping selector component."
  }'

# Try a high-priority error
curl -X POST http://localhost:9876/api/message \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "claude-code",
    "project": "gleam",
    "branch": "main",
    "priority": "high",
    "type": "error",
    "summary": "Build failed. TypeScript compilation error in the auth module."
  }'
```

Watch the dashboard update in real time!

### 4. Test voice output

For voice to work, pocket-tts needs to be running. The server auto-starts it on the first TTS request, but the first time takes ~30-60 seconds to download the voice model (~100MB).

Send a message with `context` instead of `summary` to trigger LLM summarization + voice:

```bash
curl -X POST http://localhost:9876/api/message \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "claude-code",
    "project": "gleam",
    "branch": "main",
    "context": "I refactored the authentication module to use JWT tokens instead of session cookies. Updated all the middleware, added token refresh logic, and wrote 12 new tests that all pass."
  }'
```

### 5. Try mute controls

```bash
# Mute all codex messages
curl -X POST http://localhost:9876/api/mute \
  -H 'Content-Type: application/json' \
  -d '{"target": "codex"}'

# Mute a specific project
curl -X POST http://localhost:9876/api/mute \
  -H 'Content-Type: application/json' \
  -d '{"target": "pizzabot"}'

# Unmute
curl -X POST http://localhost:9876/api/unmute \
  -H 'Content-Type: application/json' \
  -d '{"target": "codex"}'

# Mute everything
curl -X POST http://localhost:9876/api/mute \
  -H 'Content-Type: application/json' \
  -d '{"target": "all"}'
```

## Using the CLI

```bash
# Link the CLI globally (one time)
cd ~/code/agentvox && npm link

# Now you can use it from anywhere:
agentvox start        # Start server in background
agentvox status       # Check if running
agentvox send --source claude-code --project gleam --context "Just finished the refactor"
agentvox mute codex   # Mute codex
agentvox unmute codex # Unmute
agentvox omni on      # Enable omni mode (live narration)
agentvox omni off     # Disable
agentvox stop         # Stop server
```

## Hook Into Claude Code

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

Now every time Claude Code finishes a turn, it'll send a summary to AgentVox.

## Hook Into Codex

Use the wrapper script instead of calling `codex` directly:

```bash
# Instead of:
codex "fix the bug"

# Use:
bash ~/code/agentvox/hooks/codex-wrapper.sh "fix the bug"

# Or alias it:
alias codex-vox='bash ~/code/agentvox/hooks/codex-wrapper.sh'
codex-vox "fix the bug"
```

## Configure Voices

Edit `~/.agentvox/config.json` (created automatically on first run, or create it manually):

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
      "pizzabot": "marius",
      "alien-abductorama": "eponine"
    }
  }
}
```

**Voice cascade**: project voice > source voice > default voice.

Available voices: `alba`, `marius`, `javert`, `jean`, `fantine`, `cosette`, `eponine`, `azelma`

## Omni Mode (Live Narration)

Omni mode watches your Claude Code session files and narrates what the agent is doing in real time. It's like having a co-pilot who tells you "it's refactoring the auth module" or "heads up, it's going down a weird path."

```bash
# Enable via CLI
agentvox omni on

# Or via API
curl -X POST http://localhost:9876/api/omni/on

# Check status
curl http://localhost:9876/api/omni/status
```

Configure in `~/.agentvox/config.json`:

```json
{
  "omni": {
    "enabled": false,
    "intervalSeconds": 45,
    "alertOnDrift": true,
    "narrateRoutine": false
  }
}
```

## Architecture

```
Coding Agents ──POST──> AgentVox Server ──> Priority Queue ──> pocket-tts ──> Speaker
                              │
                              ├── LLM Summarizer (claude-cli / openai)
                              ├── WebSocket ──> Dashboard (localhost:9876)
                              └── Session Watcher (omni mode)
```

## Running Tests

```bash
cd ~/code/agentvox
npm test
```

25 tests across 6 test suites (config, queue, TTS, summarizer, API, watcher).
