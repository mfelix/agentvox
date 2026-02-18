import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, "..", "config", "default.json");

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object"
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadConfig(configPath) {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf-8"));

  if (!configPath || !fs.existsSync(configPath)) {
    return defaults;
  }

  const userConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return deepMerge(defaults, userConfig);
}

export const AVAILABLE_VOICES = ["alba", "marius", "javert", "jean", "fantine", "cosette", "eponine", "azelma"];

function atomicSaveConfig(key, value) {
  const configPath = path.join(process.env.HOME || "", ".agentvox", "config.json");
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch {}
  existing[key] = value;
  const tmpPath = configPath + ".tmp." + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2) + "\n");
  fs.renameSync(tmpPath, configPath);
}

export function saveVoiceConfig(voiceConfig) {
  atomicSaveConfig("voices", voiceConfig);
}

export function resolveVoice(config, project, source) {
  const voices = config.voices || {};
  if (voices.projects && voices.projects[project]) {
    return voices.projects[project];
  }
  if (voices.sources && voices.sources[source]) {
    return voices.sources[source];
  }
  return voices.default || "jean";
}

export function resolveSpeed(config, project, source) {
  const speed = config.speed || {};
  if (speed.projects && speed.projects[project]) {
    return speed.projects[project];
  }
  if (speed.sources && speed.sources[source]) {
    return speed.sources[source];
  }
  return speed.default || 1.0;
}

export function saveSpeedConfig(speedConfig) {
  atomicSaveConfig("speed", speedConfig);
}

export function saveAudioConfig(audioConfig) {
  atomicSaveConfig("audio", audioConfig);
}

export function saveSourceNames(sourceNames) {
  atomicSaveConfig("sourceNames", sourceNames);
}

export function resolveSourceName(config, source) {
  return (config.sourceNames && config.sourceNames[source]) || source;
}

export const AVAILABLE_VIBES = ["neutral", "chill", "hyped", "zen", "snarky"];

export function resolvePersonality(config, project, source) {
  const personality = config.personality || {};
  const defaults = personality.default || { verbosity: 2, vibe: "chill", humor: 25, announceSource: false };

  if (personality.projects && personality.projects[project]) {
    return { ...defaults, ...personality.projects[project] };
  }
  if (personality.sources && personality.sources[source]) {
    return { ...defaults, ...personality.sources[source] };
  }
  return defaults;
}

export function savePersonalityConfig(personalityConfig) {
  atomicSaveConfig("personality", personalityConfig);
}

const USER_CONFIG_PATH = path.join(
  process.env.HOME || "",
  ".agentvox",
  "config.json"
);

export function getConfig() {
  return loadConfig(USER_CONFIG_PATH);
}
