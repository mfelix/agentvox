import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: (fn) => vi.fn((...args) => {
    // Call the underlying mock so tests can configure it
    const opts = args[args.length - 1];
    return new Promise((resolve, reject) => {
      fn(...args.slice(0, -1), opts, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  }),
}));

describe("Summarizer", () => {
  let Summarizer, execFile;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const cp = await import("node:child_process");
    execFile = cp.execFile;

    const mod = await import("../summarizer.js");
    Summarizer = mod.Summarizer;
  });

  it("uses claude-cli method for claude-code source", async () => {
    const jsonResult = JSON.stringify({ result: "Fixed the auth bug and ran the tests." });
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, jsonResult, "");
    });

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
    expect(execFile).toHaveBeenCalled();
    expect(execFile.mock.calls[0][0]).toBe("claude");
    expect(execFile.mock.calls[0][1]).toContain("-p");
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
    expect(execFile).not.toHaveBeenCalled();
  });

  it("truncates to 100 words max", async () => {
    const longSummary = Array(150).fill("word").join(" ");
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, JSON.stringify({ result: longSummary }), "");
    });

    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      context: "stuff",
    });

    expect(result.split(" ").length).toBeLessThanOrEqual(101); // 100 + "..."
  });

  it("enforces verbosity-based word limits", async () => {
    const wordy = Array(40).fill("word").join(" ") + ".";
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, JSON.stringify({ result: wordy }), "");
    });

    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    // Verbosity 1 → max 10 words
    const v1 = await summarizer.summarize(
      { source: "claude-code", context: "stuff" },
      { verbosity: 1 }
    );
    expect(v1.split(/\s+/).filter(w => w.length > 0).length).toBeLessThanOrEqual(10);

    // Verbosity 3 → max 25 words
    const v3 = await summarizer.summarize(
      { source: "claude-code", context: "stuff" },
      { verbosity: 3 }
    );
    expect(v3.split(/\s+/).filter(w => w.length > 0).length).toBeLessThanOrEqual(25);
  });

  it("returns null for 'nothing to report' signal filter", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, JSON.stringify({ result: "nothing to report" }), "");
    });

    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      context: "agent is just reading files",
      project: "gleam",
      branch: "main",
    });

    expect(result).toBeNull();
  });

  it("does not filter responses that merely contain 'nothing to report'", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, JSON.stringify({ result: "There was nothing to report until the tests broke." }), "");
    });

    const summarizer = new Summarizer({
      "claude-code": { method: "claude-cli" },
    });

    const result = await summarizer.summarize({
      source: "claude-code",
      context: "tests failed",
      project: "gleam",
      branch: "main",
    });

    expect(result).not.toBeNull();
    expect(result).toContain("nothing to report");
  });
});
