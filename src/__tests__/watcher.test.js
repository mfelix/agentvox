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
