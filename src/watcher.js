import fs from "node:fs";
import path from "node:path";

export class SessionWatcher {
  constructor({ onActivity, intervalMs = 5000 } = {}) {
    this.onActivity = onActivity;
    this.intervalMs = intervalMs;
    this.watchedFiles = new Map(); // path -> { offset, filePath }
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

export function findSessionFiles(rootDir, maxAgeMs = 3600000, maxDepth = 10) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(fullPath);
          if (Date.now() - stat.mtimeMs < maxAgeMs) {
            results.push(fullPath);
          }
        } catch {}
      }
    }
  }

  walk(rootDir, 0);
  return results;
}
