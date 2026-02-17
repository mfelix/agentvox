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
