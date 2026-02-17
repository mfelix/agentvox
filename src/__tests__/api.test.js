import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

let app, server;

beforeAll(async () => {
  // Set a test port to avoid conflicts
  process.env.AGENTVOX_PORT = "0"; // Random port
  const mod = await import("../server.js");
  app = mod.app;
  server = mod.server;
});

afterAll(() => {
  server.close();
});

describe("POST /api/message", () => {
  it("accepts a valid message", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({
        source: "claude-code",
        project: "gleam",
        branch: "main",
        sessionId: "test-123",
        priority: "normal",
        type: "stop",
        context: "I fixed the bug",
      });

    expect(res.status).toBe(202);
    expect(res.body.queued).toBe(true);
  });

  it("rejects message without source", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({ context: "no source" });

    expect(res.status).toBe(400);
  });

  it("rejects message without context or summary", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({ source: "claude-code" });

    expect(res.status).toBe(400);
  });

  it("rejects invalid priority", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({ source: "test", context: "hello", priority: "ultra" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/priority/);
  });

  it("rejects invalid type", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({ source: "test", context: "hello", type: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type/);
  });

  it("rejects source exceeding 100 chars", async () => {
    const res = await request(app)
      .post("/api/message")
      .send({ source: "x".repeat(101), context: "hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source/);
  });
});

describe("GET /api/status", () => {
  it("returns server status", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.queue).toBeDefined();
  });
});

describe("POST /api/voices", () => {
  it("rejects invalid voice", async () => {
    const res = await request(app)
      .post("/api/voices")
      .send({ type: "source", name: "test", voice: "INVALID" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voice/);
  });

  it("accepts a valid voice", async () => {
    const res = await request(app)
      .post("/api/voices")
      .send({ type: "default", voice: "jean" });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/speed", () => {
  it("rejects speed out of range", async () => {
    const res = await request(app)
      .post("/api/speed")
      .send({ type: "source", name: "test", speed: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/speed/);
  });

  it("accepts valid speed", async () => {
    const res = await request(app)
      .post("/api/speed")
      .send({ type: "default", speed: 1.5 });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/tts/preview", () => {
  it("rejects invalid voice", async () => {
    const res = await request(app)
      .post("/api/tts/preview")
      .send({ voice: "INVALID" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voice/);
  });
});

describe("POST /api/mute", () => {
  it("mutes a source", async () => {
    const res = await request(app)
      .post("/api/mute")
      .send({ target: "codex" });

    expect(res.status).toBe(200);
    expect(res.body.muted).toContain("codex");
  });
});

describe("POST /api/unmute", () => {
  it("unmutes a source", async () => {
    // First mute
    await request(app).post("/api/mute").send({ target: "codex" });
    // Then unmute
    const res = await request(app)
      .post("/api/unmute")
      .send({ target: "codex" });

    expect(res.status).toBe(200);
    expect(res.body.muted).not.toContain("codex");
  });
});
