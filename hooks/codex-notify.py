#!/usr/bin/env python3
"""AgentVox notify hook for Codex CLI.

Add to ~/.codex/config.toml:
    notify = ["python3", "/Users/michaelfelix/code/agentvox/hooks/codex-notify.py"]

Codex calls this on every agent-turn-complete with a JSON payload as argv[1].
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_LOG_PATH = Path(
    os.environ.get("CODEX_NOTIFY_LOG", os.path.expanduser("~/.codex/log/codex-notify.log"))
)
FALLBACK_LOG_PATHS = [
    Path(os.environ.get("CODEX_NOTIFY_LOG_FALLBACK", "/tmp/codex-notify.log")),
    Path(os.path.join(os.environ.get("TMPDIR", "/tmp"), "codex-notify.log")),
]


def log_event(event: str, **fields: object) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    line = json.dumps(entry, ensure_ascii=True) + "\n"
    paths = []
    for candidate in (DEFAULT_LOG_PATH, *FALLBACK_LOG_PATHS):
        if candidate not in paths:
            paths.append(candidate)
    try:
        for path in paths:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("a", encoding="utf-8") as handle:
                    handle.write(line)
                return
            except Exception:
                continue
    except Exception:
        # Never break notify hook behavior because logging failed.
        pass


def _as_url(host_or_url: str, port: str) -> str:
    raw = (host_or_url or "").strip().rstrip("/")
    if not raw:
        return ""
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    return f"http://{raw}:{port}"


def agentvox_urls() -> list[str]:
    explicit_url = os.environ.get("AGENTVOX_URL", "").strip()
    if explicit_url:
        return [explicit_url.rstrip("/")]

    port = os.environ.get("AGENTVOX_PORT", "9876")
    candidates = []

    host = os.environ.get("AGENTVOX_HOST", "").strip()
    if host:
        url = _as_url(host, port)
        if url:
            candidates.append(url)

    # localhost works when hook runs on host; host.docker.internal often works from containerized sandboxes.
    candidates.extend([
        f"http://127.0.0.1:{port}",
        f"http://localhost:{port}",
        f"http://host.docker.internal:{port}",
    ])

    extra = os.environ.get("AGENTVOX_URL_FALLBACKS", "").strip()
    if extra:
        for item in extra.split(","):
            url = _as_url(item, port)
            if url:
                candidates.append(url)

    deduped = []
    seen = set()
    for url in candidates:
        if url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped


def main() -> int:
    if len(sys.argv) < 2:
        log_event("skip", reason="missing-argv")
        return 0

    try:
        notification = json.loads(sys.argv[1])
    except (json.JSONDecodeError, IndexError):
        log_event("skip", reason="invalid-json-argv")
        return 0

    if notification.get("type") != "agent-turn-complete":
        log_event("skip", reason="unsupported-type", notification_type=notification.get("type"))
        return 0

    urls = agentvox_urls()
    if not urls:
        log_event("skip", reason="no-agentvox-url")
        return 0

    cwd = notification.get("cwd", os.getcwd())
    thread_id = notification.get("thread-id", "")
    turn_id = notification.get("turn-id", "")
    last_message = notification.get("last-assistant-message", "")

    if not last_message:
        log_event("skip", reason="missing-last-assistant-message")
        return 0

    # Derive project info from cwd
    try:
        project_root = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd, stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        project_root = cwd

    try:
        branch = subprocess.check_output(
            ["git", "branch", "--show-current"],
            cwd=cwd, stderr=subprocess.DEVNULL, text=True
        ).strip()
    except Exception:
        branch = ""

    project = os.path.basename(project_root) if project_root else os.path.basename(cwd)
    session_id = f"codex-{thread_id}" if thread_id else f"codex-{turn_id}"

    payload = json.dumps({
        "source": "codex",
        "project": project,
        "branch": branch,
        "worktree": project_root,
        "sessionId": session_id,
        "priority": "normal",
        "type": "stop",
        "context": last_message[:2000],
    })

    delivered = False
    for index, url in enumerate(urls, start=1):
        target = f"{url}/api/message"
        cmd = [
            "curl", "-sS", "-f",
            "--connect-timeout", "1.5",
            "--max-time", "3",
            "-X", "POST", target,
            "-H", "Content-Type: application/json",
            "-d", payload,
        ]

        try:
            result = subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                log_event(
                    "delivered",
                    session_id=session_id,
                    project=project,
                    branch=branch,
                    url=target,
                    context_chars=len(last_message[:2000]),
                    attempt=index,
                )
                delivered = True
                break

            log_event(
                "delivery-attempt-failed",
                session_id=session_id,
                project=project,
                branch=branch,
                url=target,
                returncode=result.returncode,
                error=(result.stderr or "").strip()[:1000],
                attempt=index,
            )
        except Exception as exc:
            log_event(
                "delivery-attempt-exception",
                session_id=session_id,
                project=project,
                branch=branch,
                url=target,
                error=str(exc),
                attempt=index,
            )

    if not delivered:
        log_event(
            "delivery-failed",
            session_id=session_id,
            project=project,
            branch=branch,
            attempts=len(urls),
            tried=urls,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
