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
    # Extract last few assistant messages
    CONTEXT=$(python3 -c "
import json, sys

session_file = sys.argv[1]
msgs = []
with open(session_file, 'r') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            if data.get('type') != 'assistant':
                continue
            content = data.get('message', {}).get('content', '')
            if isinstance(content, str):
                msgs.append(content[:500])
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get('type') == 'text':
                        msgs.append(item.get('text', '')[:500])
        except Exception:
            pass
# Last 3 assistant messages
for msg in msgs[-3:]:
    print(msg)
" "$SESSION_FILE" 2>/dev/null || echo "")
fi

if [[ -z "$CONTEXT" ]]; then
    echo '{"decision": "approve"}'
    exit 0
fi

# POST to AgentVox (background, non-blocking)
# Use python3 for safe JSON construction to avoid shell escaping issues
python3 -c "
import json, subprocess, sys

payload = json.dumps({
    'source': 'claude-code',
    'project': sys.argv[1],
    'branch': sys.argv[2],
    'worktree': sys.argv[3],
    'sessionId': sys.argv[4],
    'priority': 'normal',
    'type': 'stop',
    'context': sys.argv[5][:2000]
})

subprocess.Popen(
    ['curl', '-sf', '-X', 'POST', sys.argv[6] + '/api/message',
     '-H', 'Content-Type: application/json',
     '-d', payload],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL
)
" "$PROJECT" "$BRANCH" "$WORKTREE" "$SESSION_ID" "$CONTEXT" "$AGENTVOX_URL" &

echo '{"decision": "approve"}'
