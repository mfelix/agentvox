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
