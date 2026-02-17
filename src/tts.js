import { execSync, spawn } from "node:child_process";
import fs from "node:fs";

export class TtsEngine {
  constructor({ host = "localhost", port = 8000 } = {}) {
    this.host = host;
    this.port = port;
    this.baseUrl = `http://${host}:${port}`;
    this.serverProcess = null;
    this.speaking = false;
    this.currentProcess = null;
  }

  async checkHealth() {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureServer() {
    if (await this.checkHealth()) return;

    console.log("Starting pocket-tts server...");
    this.serverProcess = spawn(
      "uvx",
      ["pocket-tts", "serve", "--host", this.host, "--port", String(this.port)],
      { stdio: "ignore", detached: true }
    );
    this.serverProcess.unref();

    // Wait for server to be ready (max 60s)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.checkHealth()) {
        console.log("pocket-tts server ready");
        return;
      }
    }
    throw new Error("pocket-tts server failed to start within 60 seconds");
  }

  async speak(text, voice) {
    await this.ensureServer();

    this.speaking = true;

    return new Promise((resolve, reject) => {
      const args = [
        "-s", "-X", "POST",
        `${this.baseUrl}/tts`,
        "-F", `text=${text}`,
      ];
      if (voice) {
        args.push("-F", `voice_url=${voice}`);
      }

      // Try streaming to ffplay first, fall back to temp file + afplay
      const curl = spawn("curl", args, { stdio: ["ignore", "pipe", "ignore"] });
      const player = spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "pipe:0"], {
        stdio: ["pipe", "ignore", "ignore"],
      });

      curl.stdout.pipe(player.stdin);

      player.on("error", () => {
        // ffplay not available, fall back to afplay
        curl.kill();
        this._speakFallback(text, voice).then(resolve).catch(reject);
      });

      player.on("close", (code) => {
        this.speaking = false;
        this.currentProcess = null;
        resolve();
      });

      this.currentProcess = { curl, player };
    });
  }

  async _speakFallback(text, voice) {
    await this.ensureServer();

    return new Promise((resolve, reject) => {
      const tmpFile = `/tmp/agentvox-tts-${Date.now()}.wav`;
      const args = [
        "-s", "-X", "POST",
        `${this.baseUrl}/tts`,
        "-F", `text=${text}`,
        "-o", tmpFile,
      ];
      if (voice) {
        args.push("-F", `voice_url=${voice}`);
      }

      const curl = spawn("curl", args);
      curl.on("close", (code) => {
        if (code !== 0) {
          this.speaking = false;
          return reject(new Error("curl failed"));
        }

        const player = spawn("afplay", [tmpFile]);
        player.on("close", () => {
          this.speaking = false;
          this.currentProcess = null;
          try { fs.unlinkSync(tmpFile); } catch {}
          resolve();
        });
        this.currentProcess = { player };
      });
    });
  }

  stop() {
    if (this.currentProcess) {
      if (this.currentProcess.curl) this.currentProcess.curl.kill();
      if (this.currentProcess.player) this.currentProcess.player.kill();
      this.currentProcess = null;
    }
    this.speaking = false;
  }

  isSpeaking() {
    return this.speaking;
  }
}
