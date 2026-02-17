#!/usr/bin/env bash
# AgentVox wrapper for Codex CLI
# Usage: codex-wrapper.sh [any codex args]
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
# Use python3 for safe JSON construction to avoid shell escaping issues
python3 -c "
import json, subprocess, sys

payload = json.dumps({
    'source': 'codex',
    'project': sys.argv[1],
    'branch': sys.argv[2],
    'worktree': sys.argv[3],
    'sessionId': sys.argv[4],
    'priority': sys.argv[5],
    'type': sys.argv[6],
    'context': sys.argv[7][:2000]
})

subprocess.Popen(
    ['curl', '-sf', '-X', 'POST', sys.argv[8] + '/api/message',
     '-H', 'Content-Type: application/json',
     '-d', payload],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL
)
" "$PROJECT" "$BRANCH" "$WORKTREE" "$SESSION_ID" "$PRIORITY" "$TYPE" "$CONTEXT" "$AGENTVOX_URL" &

exit $EXIT_CODE
