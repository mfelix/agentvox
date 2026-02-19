import { execFileSync } from "node:child_process";
import { cleanForSpeech } from "./tts.js";

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

  return `Summarize this coding event for spoken audio. The listener is NOT looking at code — they're just listening.
${VERBOSITY_PROMPTS[v] || VERBOSITY_PROMPTS[2]}
${VIBE_PROMPTS[vibe] || VIBE_PROMPTS.chill}
${humorPrompt(humor)}
NEVER start with "The agent" or "The assistant" or "The coding". Vary your sentence openings.
Describe WHAT happened in plain human language. Focus on the purpose and outcome, not implementation details.
NEVER include: function names, line numbers, variable names, file paths, URLs, port numbers, code snippets, method calls, CSS properties, or any token that only makes sense when reading code.
BAD: "Fixed renderHistory at line 338 where slice minus five reverse produces five messages"
BAD: "Server running at http 127.0.0.1 colon 9876"
GOOD: "Fixed a bug where the oldest message was showing up brightest instead of fading out"
GOOD: "The server is back up and ready"
NEVER use emojis. Plain text only, no emoji characters whatsoever.
Respond with ONLY the summary text, nothing else.`;
}

function buildOmniPrompt(project, branch, activity, personality = {}) {
  const v = personality.verbosity || 2;
  const vibe = personality.vibe || "chill";
  const humor = personality.humor ?? 25;

  return `Narrate a coding agent's live activity on ${project}${branch ? ` (${branch} branch)` : ""}. The listener is NOT looking at code — they're just listening.
${VERBOSITY_PROMPTS[v] || VERBOSITY_PROMPTS[2]}
${VIBE_PROMPTS[vibe] || VIBE_PROMPTS.chill}
${humorPrompt(humor)}
Speak in present tense. NEVER start with "The agent" or "The assistant".
Vary your openings. Be specific about features being worked on, described in plain human language.
Describe WHAT is happening and WHY, not implementation specifics.
NEVER include: function names, line numbers, variable names, file paths, URLs, port numbers, code snippets, method calls, CSS properties, or any token that only makes sense when reading code.
BAD: "Updating the renderHistory function on line 338 to fix the nth-child CSS selector"
GOOD: "Fixing a display bug so newer messages appear brighter and older ones fade out"
NEVER use emojis. Plain text only, no emoji characters whatsoever.
Respond with ONLY the narration text.

Recent activity:
${activity}`;
}

function wordCount(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

function truncate(text, maxWords = 100) {
  if (!text) return "";
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= maxWords) return text.trim();
  // Always prefer ending at a sentence boundary — even if it means fewer words.
  // Search within the word limit for the last sentence-ending punctuation.
  const limited = words.slice(0, maxWords).join(" ");
  const lastSentenceEnd = Math.max(
    limited.lastIndexOf("."),
    limited.lastIndexOf("!"),
    limited.lastIndexOf("?")
  );
  // Use any sentence boundary we can find (no minimum threshold)
  if (lastSentenceEnd > 0) {
    return limited.slice(0, lastSentenceEnd + 1).trim();
  }
  // No sentence boundary at all — take the words as-is
  return limited.trim();
}

export class Summarizer {
  constructor(config = {}) {
    this.config = config;
  }

  async summarize({ source, context, summary, project, branch }, personality = {}) {
    const maxWords = [null, 15, 25, 40, 60, 80][personality.verbosity || 2];

    // If pre-made summary provided, check if it's short enough to use directly
    if (summary) {
      const cleaned = cleanForSpeech(summary);
      if (wordCount(cleaned) <= maxWords) return cleaned;
      // Too long — feed it to the LLM as context so verbosity controls apply
      context = cleaned;
    }

    const sourceConfig = this.config[source] || { method: "claude-cli" };

    let result;
    if (sourceConfig.method === "claude-cli") {
      result = await this._claudeCli(context, project, branch, personality);
    } else if (sourceConfig.method === "openai") {
      result = await this._openai(context, project, branch, sourceConfig.model, personality);
    } else {
      // Fallback: clean and truncate the context
      result = truncate(cleanForSpeech(context), maxWords);
    }

    // Clean any remaining markdown/emojis from LLM output
    result = cleanForSpeech(result);

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
      return truncate(cleanForSpeech(data.result || ""), maxWords);
    } catch {
      return null; // Nothing to say
    }
  }

  async _claudeCli(context, project, branch, personality = {}) {
    const maxWords = [null, 15, 25, 40, 60, 80][personality.verbosity || 2];
    const systemPrompt = buildPrompt(personality);
    const fullPrompt = `${systemPrompt}\n\nProject: ${project || "unknown"}\nBranch: ${branch || "unknown"}\n\nContext:\n${context}`;
    try {
      const output = execFileSync("claude", [
        "-p", "--output-format", "json",
        "--no-session-persistence", "--setting-sources", "",
        fullPrompt
      ], { encoding: "utf-8", timeout: 30000 });
      const data = JSON.parse(output);
      return data.result || truncate(cleanForSpeech(context), maxWords);
    } catch {
      return truncate(cleanForSpeech(context), maxWords);
    }
  }

  async _openai(context, project, branch, model = "gpt-4o-mini", personality = {}) {
    const maxWords = [null, 15, 25, 40, 60, 80][personality.verbosity || 2];
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
      return response.choices[0]?.message?.content || truncate(cleanForSpeech(context), maxWords);
    } catch {
      return truncate(cleanForSpeech(context), maxWords);
    }
  }
}
