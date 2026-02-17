import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

describe("Summarizer", () => {
  let Summarizer, execFileSync;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const cp = await import("node:child_process");
    execFileSync = cp.execFileSync;

    const mod = await import("../summarizer.js");
    Summarizer = mod.Summarizer;
  });

  it("uses claude-cli method for claude-code source", async () => {
    execFileSync.mockReturnValueOnce(
      JSON.stringify({ result: "Fixed the auth bug and ran the tests." })
    );

    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      context: "I fixed a bug in the auth handler...",
      project: "gleam",
      branch: "main",
    });

    expect(result).toBe("Fixed the auth bug and ran the tests.");
    expect(execFileSync).toHaveBeenCalled();
    expect(execFileSync.mock.calls[0][0]).toBe("claude");
    expect(execFileSync.mock.calls[0][1]).toContain("-p");
  });

  it("returns pre-made summary without LLM call", async () => {
    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      summary: "Already summarized for you.",
      context: "ignored",
    });

    expect(result).toBe("Already summarized for you.");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("truncates to 100 words max", async () => {
    const longSummary = Array(150).fill("word").join(" ");
    execFileSync.mockReturnValueOnce(JSON.stringify({ result: longSummary }));

    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      context: "stuff",
    });

    expect(result.split(" ").length).toBeLessThanOrEqual(101); // 100 + "..."
  });
});
