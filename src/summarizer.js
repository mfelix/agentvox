import { execFileSync } from "node:child_process";

const VERBOSITY_PROMPTS = {
  1: "Maximum 10 words. Ultra-brief. Just the essential fact, nothing more.",
  2: "Maximum 15 words. Terse and direct. Key facts only.",
  3: "15-25 words. Standard summary with enough context to understand.",
  4: "25-40 words. Include detail, reasoning, and what's next.",
  5: "40-60 words. Full narration with reasoning, detail, and next steps.",
};

const VIBE_PROMPTS = {
  neutral: "Straightforward, matter-of-fact tone. No emotional coloring.",
  chill: "Relaxed, casual tone. Like updating a friend over coffee.",
  hyped: "Energetic and enthusiastic. Show genuine excitement about progress.",
  zen: "Calm, mindful, and reflective. Measured and peaceful, like a meditation guide.",
  snarky: "Dry wit and playful irreverence. Clever but never mean-spirited.",
};

function humorPrompt(level) {
  if (level === 0) return "No humor or personality whatsoever. Pure information only.";
  if (level <= 25) return "Minimal personality. Mostly factual with rare light touches.";
  if (level <= 50) return "Balanced personality and information. Some wit is welcome.";
  if (level <= 75) return "Personality-forward. Be witty, engaging, and show character.";
  return "Maximum personality. Clever, playful, punny, full of character. Entertainment matters as much as information.";
}

function buildPrompt(personality = {}) {
  const v = personality.verbosity || 2;
  const vibe = personality.vibe || "chill";
  const humor = personality.humor ?? 25;

  return `Summarize this coding event for spoken audio.
${VERBOSITY_PROMPTS[v] || VERBOSITY_PROMPTS[2]}
${VIBE_PROMPTS[vibe] || VIBE_PROMPTS.chill}
${humorPrompt(humor)}
NEVER start with "The agent" or "The assistant" or "The coding". Vary your sentence openings.
Never include file paths, UUIDs, or technical jargon — use natural language.
NEVER use emojis. Plain text only, no emoji characters whatsoever.
Respond with ONLY the summary text, nothing else.`;
}

function buildOmniPrompt(project, branch, activity, personality = {}) {
  const v = personality.verbosity || 2;
  const vibe = personality.vibe || "chill";
  const humor = personality.humor ?? 25;

  return `Narrate a coding agent's live activity on ${project}${branch ? ` (${branch} branch)` : ""}.
${VERBOSITY_PROMPTS[v] || VERBOSITY_PROMPTS[2]}
${VIBE_PROMPTS[vibe] || VIBE_PROMPTS.chill}
${humorPrompt(humor)}
Speak in present tense. NEVER start with "The agent" or "The assistant".
Vary your openings. Be specific about features being worked on.
Never include file paths, UUIDs, or technical identifiers.
NEVER use emojis. Plain text only, no emoji characters whatsoever.
Respond with ONLY the narration text.

Recent activity:
${activity}`;
}

function truncate(text, maxWords = 100) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

export class Summarizer {
  constructor(config = {}) {
    this.config = config;
  }

  async summarize({ source, context, summary, project, branch }, personality = {}) {
    // If pre-made summary provided, use it directly
    if (summary) return summary;

    const sourceConfig = this.config[source] || { method: "claude-cli" };

    let result;
    if (sourceConfig.method === "claude-cli") {
      result = await this._claudeCli(context, project, branch, personality);
    } else if (sourceConfig.method === "openai") {
      result = await this._openai(context, project, branch, sourceConfig.model, personality);
    } else {
      // Fallback: just truncate the context
      result = truncate(context, 25);
    }

    const maxWords = [null, 15, 25, 40, 60, 80][personality.verbosity || 2];
    return truncate(result, maxWords);
  }

  async summarizeOmni({ project, branch, activity }, personality = {}) {
    const prompt = buildOmniPrompt(project, branch, activity, personality);
    try {
      const output = execFileSync("claude", [
        "-p", "--output-format", "json",
        "--no-session-persistence", "--setting-sources", "",
        prompt
      ], { encoding: "utf-8", timeout: 30000 });
      const data = JSON.parse(output);
      const maxWords = [null, 15, 25, 40, 60, 80][personality.verbosity || 2];
      return truncate(data.result || "", maxWords);
    } catch {
      return null; // Nothing to say
    }
  }

  async _claudeCli(context, project, branch, personality = {}) {
    const systemPrompt = buildPrompt(personality);
    const fullPrompt = `${systemPrompt}\n\nProject: ${project || "unknown"}\nBranch: ${branch || "unknown"}\n\nContext:\n${context}`;
    try {
      const output = execFileSync("claude", [
        "-p", "--output-format", "json",
        "--no-session-persistence", "--setting-sources", "",
        fullPrompt
      ], { encoding: "utf-8", timeout: 30000 });
      const data = JSON.parse(output);
      return data.result || context.slice(0, 100);
    } catch {
      return context.slice(0, 100);
    }
  }

  async _openai(context, project, branch, model = "gpt-4o-mini", personality = {}) {
    // Dynamic import to avoid requiring openai when not used
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI();
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: buildPrompt(personality) },
          {
            role: "user",
            content: `Project: ${project || "unknown"}\nBranch: ${branch || "unknown"}\n\nContext:\n${context}`,
          },
        ],
        max_tokens: [null, 50, 60, 80, 120, 150][personality.verbosity || 2] || 100,
      });
      return response.choices[0]?.message?.content || context.slice(0, 100);
    } catch {
      return context.slice(0, 100);
    }
  }
}
