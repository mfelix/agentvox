#!/usr/bin/env node

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0];
const PID_DIR = path.join(process.env.HOME || "", ".agentvox");
const PID_FILE = path.join(PID_DIR, "agentvox.pid");
const DEFAULT_PORT = 9876;

function getPort() {
  const port = parseInt(process.env.AGENTVOX_PORT || DEFAULT_PORT, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

function getBaseUrl() {
  return `http://localhost:${getPort()}`;
}

function getPidFromFile() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return null;
  }
}

function getPidFromPort() {
  try {
    const output = execFileSync("lsof", ["-ti", `:${getPort()}`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pids = output.trim().split("\n").map(Number).filter(Boolean);
    for (const pid of pids) {
      try {
        const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf-8",
        }).trim();
        if (cmd.includes("node") && cmd.includes("server.js")) return pid;
      } catch {}
    }
  } catch {}
  return null;
}

function isRunning() {
  return !!(getPidFromFile() || getPidFromPort());
}

function parseFlags(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}

async function apiPost(path, body = {}) {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(`${getBaseUrl()}${path}`);
  return res.json();
}

switch (command) {
  case "start": {
    const existingPid = getPidFromFile() || getPidFromPort();
    if (existingPid) {
      console.log(`AgentVox is already running (pid ${existingPid}).`);
      process.exit(0);
    }
    const serverPath = path.join(__dirname, "..", "src", "server.js");
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn("node", [serverPath], {
      stdio: "ignore",
      detached: true,
      env,
    });
    child.unref();
    fs.mkdirSync(PID_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
    console.log(`AgentVox started (pid ${child.pid})`);
    break;
  }

  case "stop": {
    const pid = getPidFromFile() || getPidFromPort();
    if (!pid) {
      console.log("AgentVox is not running.");
      process.exit(0);
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    console.log(`AgentVox stopped (pid ${pid}).`);
    break;
  }

  case "status": {
    if (!isRunning()) {
      console.log("AgentVox is not running.");
      process.exit(0);
    }
    try {
      const data = await apiGet("/api/status");
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.log("AgentVox is running but not responding.");
    }
    break;
  }

  case "send": {
    const opts = parseFlags(args.slice(1));
    if (!opts.source) {
      console.error(
        "Usage: agentvox send --source <source> [--project <project>] [--branch <branch>] [--context <text>] [--priority <low|normal|high>]"
      );
      process.exit(1);
    }
    const body = {
      source: opts.source,
      project: opts.project || path.basename(process.cwd()),
      branch: opts.branch || null,
      context: opts.context || opts.summary || "",
      summary: opts.summary || null,
      priority: opts.priority || "normal",
      type: opts.type || "stop",
    };

    // Try to get git branch if not provided
    if (!body.branch) {
      try {
        body.branch = execFileSync("git", ["branch", "--show-current"], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
        }).trim();
      } catch {}
    }

    try {
      const data = await apiPost("/api/message", body);
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.error("Failed to send message. Is AgentVox running?");
      process.exit(1);
    }
    break;
  }

  case "mute": {
    const target = args[1] || "all";
    try {
      const data = await apiPost("/api/mute", { target });
      console.log(`Muted: ${target}`);
    } catch {
      console.error("Failed. Is AgentVox running?");
      process.exit(1);
    }
    break;
  }

  case "unmute": {
    const target = args[1] || "all";
    try {
      const data = await apiPost("/api/unmute", { target });
      console.log(`Unmuted: ${target}`);
    } catch {
      console.error("Failed. Is AgentVox running?");
      process.exit(1);
    }
    break;
  }

  case "omni": {
    const subcommand = args[1];
    if (subcommand !== "on" && subcommand !== "off") {
      console.error("Usage: agentvox omni [on|off]");
      process.exit(1);
    }
    try {
      const data = await apiPost(`/api/omni/${subcommand}`);
      console.log(`Omni mode: ${subcommand}`);
    } catch {
      console.error("Failed. Is AgentVox running?");
      process.exit(1);
    }
    break;
  }

  default:
    console.log(`AgentVox - Voice hub for AI coding agents

Usage:
  agentvox start                     Start the server
  agentvox stop                      Stop the server
  agentvox status                    Check server status
  agentvox send --source <s> ...     Push a message
  agentvox mute [source|project]     Mute a source/project (or all)
  agentvox unmute [source|project]   Unmute
  agentvox omni [on|off]             Toggle omni mode
`);
}
