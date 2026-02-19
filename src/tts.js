import { execSync, spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Strip emojis, markdown formatting, and other non-speech artifacts from text.
 * Used both before TTS and when storing spokenText.
 */
export function cleanForSpeech(text) {
  if (!text) return "";
  return text
    // Strip all emoji characters (presentation + text-style like ✅ ✓ ⚡ etc.)
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f\u20e3\u2600-\u27bf]/gu, "")
    // Strip markdown headings (## Heading)
    .replace(/^#{1,6}\s+/gm, "")
    // Strip markdown horizontal rules (---, ***, ___)
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Strip markdown bold/italic (**text**, *text*, __text__, _text_)
    .replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2")
    // Strip markdown inline code (`code`)
    .replace(/`([^`]*)`/g, "$1")
    // Strip markdown code blocks (```...```)
    .replace(/```[\s\S]*?```/g, "")
    // Strip markdown links [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Strip markdown images ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Strip markdown blockquotes (> text)
    .replace(/^>\s+/gm, "")
    // Strip markdown list markers (- item, * item, 1. item)
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    // Collapse multiple whitespace/newlines into single space
    .replace(/\s+/g, " ")
    .trim();
}

const DEFAULT_AUDIO = {
  gain: 1.0,
  compressor: false,
  limiter: false,
  eq: { bass: 0, mid: 0, treble: 0 },
  reverb: { enabled: false, amount: 30 },
};

function buildFilterChain(speed, audio) {
  const filters = [];
  if (speed !== 1.0) filters.push(`atempo=${speed}`);

  // EQ: bass, mid (presence), treble
  const { bass = 0, mid = 0, treble = 0 } = audio.eq || {};
  if (bass !== 0) filters.push(`bass=gain=${bass}:frequency=120`);
  if (mid !== 0) filters.push(`equalizer=f=2500:t=h:w=1200:g=${mid}`);
  if (treble !== 0) filters.push(`treble=gain=${treble}:frequency=4000`);

  if (audio.gain !== 1.0) filters.push(`volume=${audio.gain}`);
  if (audio.compressor) filters.push("acompressor=threshold=-18dB:ratio=6:attack=5:release=100:makeup=6dB");
  if (audio.limiter) filters.push("alimiter=limit=0.9:attack=3:release=50");

  // Reverb via aecho — scale delays and decay from the amount (0-100)
  const reverb = audio.reverb || {};
  if (reverb.enabled) {
    const amt = Math.max(0, Math.min(100, reverb.amount ?? 30));
    const d1 = Math.round(30 + amt * 0.7);       // 30-100ms
    const d2 = Math.round(60 + amt * 1.4);       // 60-200ms
    const d3 = Math.round(90 + amt * 2.1);       // 90-300ms
    const dec1 = (0.15 + amt * 0.004).toFixed(3); // 0.15-0.55
    const dec2 = (0.10 + amt * 0.003).toFixed(3); // 0.10-0.40
    const dec3 = (0.05 + amt * 0.002).toFixed(3); // 0.05-0.25
    const outGain = (0.95 - amt * 0.002).toFixed(2); // keep output level stable
    filters.push(`aecho=0.8:${outGain}:${d1}|${d2}|${d3}:${dec1}|${dec2}|${dec3}`);
  }

  return filters;
}

export class TtsEngine {
  constructor({ host = "localhost", port = 8000 } = {}) {
    this.host = host;
    this.port = port;
    this.baseUrl = `http://${host}:${port}`;
    this.serverProcess = null;
    this.speaking = false;
    this.currentProcess = null;
    // Internal promise chain so all callers are serialized — no overlapping audio
    this._speechQueue = Promise.resolve();
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

  speak(text, voice, speed = 1.0, audio = {}) {
    const opts = { ...DEFAULT_AUDIO, ...audio, eq: { ...DEFAULT_AUDIO.eq, ...audio.eq }, reverb: { ...DEFAULT_AUDIO.reverb, ...audio.reverb } };
    // All speak calls are serialized through this queue to prevent overlapping audio.
    // This guarantees that no matter who calls speak() — API messages, omni narration,
    // or voice preview — only one utterance plays at a time.
    const promise = this._speechQueue
      .then(() => this._doSpeak(text, voice, speed, opts))
      .catch((err) => console.error("TTS speech error:", err));
    this._speechQueue = promise;
    return promise;
  }

  async _doSpeak(text, voice, speed, audio) {
    await this.ensureServer();

    // Clean text for speech — strip emojis, markdown, and other non-speech artifacts
    text = cleanForSpeech(text);

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
      const ffplayArgs = ["-nodisp", "-autoexit", "-loglevel", "quiet"];

      const filters = buildFilterChain(speed, audio);
      if (filters.length > 0) {
        ffplayArgs.push("-af", filters.join(","));
      }
      ffplayArgs.push("-i", "pipe:0");
      const player = spawn("ffplay", ffplayArgs, {
        stdio: ["pipe", "ignore", "ignore"],
      });

      curl.stdout.pipe(player.stdin);

      player.on("error", () => {
        // ffplay not available, fall back to afplay
        curl.kill();
        this._speakFallback(text, voice, speed, audio).then(resolve).catch(reject);
      });

      player.on("close", (code) => {
        this.speaking = false;
        this.currentProcess = null;
        resolve();
      });

      this.currentProcess = { curl, player };
    });
  }

  async _speakFallback(text, voice, speed, audio) {
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

        const filters = buildFilterChain(1.0, audio); // speed handled by afplay -r
        if (filters.length > 0) {
          const processedFile = tmpFile.replace(".wav", "-processed.wav");
          const ffmpegArgs = ["-y", "-i", tmpFile, "-af", filters.join(","), processedFile];
          const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: "ignore" });
          ffmpeg.on("close", (ffCode) => {
            const playFile = ffCode === 0 ? processedFile : tmpFile;
            const afplayArgs = [playFile];
            if (speed !== 1.0) afplayArgs.push("-r", String(speed));
            const player = spawn("afplay", afplayArgs);
            player.on("close", () => {
              this.speaking = false;
              this.currentProcess = null;
              try { fs.unlinkSync(tmpFile); } catch {}
              try { fs.unlinkSync(processedFile); } catch {}
              resolve();
            });
            this.currentProcess = { player };
          });
        } else {
          const afplayArgs = [tmpFile];
          if (speed !== 1.0) afplayArgs.push("-r", String(speed));
          const player = spawn("afplay", afplayArgs);
          player.on("close", () => {
            this.speaking = false;
            this.currentProcess = null;
            try { fs.unlinkSync(tmpFile); } catch {}
            resolve();
          });
          this.currentProcess = { player };
        }
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
