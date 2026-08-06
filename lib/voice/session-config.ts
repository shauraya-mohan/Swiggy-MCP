// Builds the OpenAI Realtime *GA* session config from the system prompt + tool
// manifest. Kept separate from the route handler so it can be unit-tested
// without spinning up a fetch stub.
//
// Targets the GA endpoint:
//   POST https://api.openai.com/v1/realtime/client_secrets
//   docs: https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/

import fs from "node:fs";
import path from "node:path";
import { toolsForOpenAI } from "../mcp/router";

/** Built-in OpenAI Realtime voices. `sage` is our production pick (calm,
 *  measured, neutral) — see buildSessionConfig's default. */
export type RealtimeVoice =
  | "alloy"
  | "ash"
  | "ballad"
  | "coral"
  | "echo"
  | "sage"
  | "shimmer"
  | "verse"
  | "marin"
  | "cedar";

/**
 * GA Realtime output modalities. Note: unlike the legacy beta endpoint, GA
 * accepts EXACTLY ONE of "audio" or "text" — you can't request both.
 *  - ["audio"] : model speaks; also emits a transcript stream (what we use —
 *                OpenAI's native voice `sage` carries the agent's speech)
 *  - ["text"]  : model emits text only; would need an external TTS to speak.
 *                Kept as an option but not used — we ship native audio out.
 */
export type RealtimeModality = "audio" | "text";

/**
 * Turn-taking mode:
 *  - "manual"     : no server VAD, client commits the audio buffer via
 *                   `input_audio_buffer.commit` + `response.create`. Best for
 *                   a deliberate tap-to-talk UX. The model never auto-responds
 *                   and never self-interrupts on echo bleed.
 *  - "server_vad" : OpenAI detects turn boundaries from silence. Hands-free
 *                   but very sensitive to background noise / speaker bleed.
 */
export type TurnDetection = "manual" | "server_vad";

export interface SessionConfigOptions {
  /** Default ["audio"] — native voice out. ["text"] only if pairing an external TTS. */
  outputModalities?: RealtimeModality[];
  voice?: RealtimeVoice;
  /** 1.0 default, 0.25..1.5 allowed. */
  speed?: number;
  /** Seconds the client secret is valid for. 10..7200. */
  ttlSeconds?: number;
  /** Default "manual". See TurnDetection for the trade-off. */
  turnDetection?: TurnDetection;
}

// Cache the on-disk markdown — it doesn't change at runtime in prod,
// and `next dev` restarts the process on edits. The TIME-CONTEXT block
// appended below is recomputed on every call so the agent always sees
// the current date (otherwise a server that's been up for a day would
// tell the model it's still yesterday).
let cachedBasePrompt: string | null = null;

function loadBasePrompt(): string {
  if (cachedBasePrompt) return cachedBasePrompt;
  const p = path.join(process.cwd(), "agent", "prompts", "system.md");
  cachedBasePrompt = fs.readFileSync(p, "utf-8");
  return cachedBasePrompt;
}

/**
 * Render the `## Current time context` block that gets appended to the
 * system prompt at session-mint time. Without this the model has no
 * idea what "today" / "tonight" / "tomorrow" mean — it falls back to
 * its training cutoff, which is months stale and causes
 * `dineout__get_available_slots` to be called with the wrong date.
 *
 * Exported for tests; the route handler doesn't call it directly.
 */
export function buildTimeContextBlock(now: Date = new Date()): string {
  const iso = now.toISOString().slice(0, 10); // "2026-05-13"
  const dow = now.toLocaleDateString("en-US", { weekday: "long" }); // "Wednesday"
  const monthDay = now.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }); // "May 13, 2026"
  const hour = now.getHours();
  const timeOfDay =
    hour < 5 ? "late night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";
  // Resolve the timezone the server is running in. Falls back to UTC
  // if Intl is unavailable (shouldn't happen in Node 20+).
  let tz = "UTC";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* keep UTC */
  }

  // Pre-compute the next 7 dates so the model can resolve "this Friday"
  // / "next Tuesday" without doing date math at inference time. ISO
  // dates are zero-ambiguity, unlike spoken phrases.
  const upcoming: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const dayName = d.toLocaleDateString("en-US", { weekday: "long" });
    const dayIso = d.toISOString().slice(0, 10);
    upcoming.push(`  - ${dayName}: ${dayIso}`);
  }

  return [
    "## Current time context",
    "",
    `Right now it is **${dow}, ${monthDay}** (${timeOfDay}, ${tz}).`,
    "",
    "When the user says a relative time, resolve it to an ISO date BEFORE calling any tool:",
    `- \"today\" / \"tonight\" → \`date: \"${iso}\"\``,
    "- \"tomorrow\" → the next day's ISO",
    "- \"this Friday\" / \"next Saturday\" → pick from the table below; never guess the year",
    "",
    "Upcoming dates (server clock):",
    upcoming.join("\n"),
    "",
    "All slot times returned by tools are 24-hour `HH:MM` in the same timezone — you can speak them naturally (\"seven-thirty\") without conversion.",
    "",
  ].join("\n");
}

/**
 * Full system prompt: base markdown from disk + time-context block.
 * Called once per `/api/voice/session` mint, so each fresh session
 * gets the current date even if the server has been running for days.
 *
 * @param now Optional override for the "current time" used in the
 *            time-context block. Tests pin this to a fixed date so the
 *            output is deterministic; production always uses now().
 */
export function loadSystemPrompt(now?: Date): string {
  return `${loadBasePrompt()}\n\n${buildTimeContextBlock(now)}`;
}

// =========================================================================
// GA shape — exactly matches POST /v1/realtime/client_secrets body
// =========================================================================

export type TurnDetectionConfig =
  | null
  | {
      type: "server_vad";
      threshold: number;
      prefix_padding_ms: number;
      silence_duration_ms: number;
      create_response: boolean;
      interrupt_response: boolean;
    };

export interface ClientSecretRequest {
  expires_after?: { anchor: "created_at"; seconds: number };
  session: {
    type: "realtime";
    model: string;
    instructions: string;
    output_modalities: RealtimeModality[];
    tools: ReturnType<typeof toolsForOpenAI>;
    tool_choice: "auto" | "none" | "required";
    audio: {
      input: {
        transcription: { model: string };
        /** `null` = manual turn-taking; client commits the buffer itself. */
        turn_detection: TurnDetectionConfig;
        noise_reduction: { type: "near_field" | "far_field" };
      };
      output: {
        voice: RealtimeVoice;
        speed: number;
      };
    };
  };
}

export function buildSessionConfig(opts: SessionConfigOptions = {}): ClientSecretRequest {
  const mode: TurnDetection = opts.turnDetection ?? "manual";

  // Push-to-talk default: no server VAD, no auto-response, no echo-driven
  // self-interrupt. The client commits the audio buffer when the user
  // releases the talk button. Flip to "server_vad" once the UX matures.
  const turnDetection: TurnDetectionConfig =
    mode === "manual"
      ? null
      : {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
          // Yields mid-sentence when the user starts talking. Pairs with VAD.
          interrupt_response: true,
        };

  return {
    expires_after: {
      anchor: "created_at",
      // 10-minute default — long enough for the user to start a conversation,
      // short enough that a leaked secret has limited blast radius.
      seconds: opts.ttlSeconds ?? 600,
    },
    session: {
      type: "realtime",
      model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime",
      instructions: loadSystemPrompt(),
      // GA disallows both audio+text. Default to ["audio"]; transcripts still
      // stream as `conversation.item.input_audio_transcription.delta` events.
      output_modalities: opts.outputModalities ?? ["audio"],
      tools: toolsForOpenAI(),
      tool_choice: "auto",
      audio: {
        input: {
          transcription: {
            // gpt-realtime-whisper is the GA transcriber — lower latency than
            // whisper-1 and tuned for the realtime model.
            model: "gpt-realtime-whisper",
          },
          turn_detection: turnDetection,
          // The user is talking to a laptop/phone mic from across the kitchen —
          // far_field tolerates ambient noise (extractor fan, running water).
          noise_reduction: { type: "far_field" },
        },
        output: {
          // Default voice is `sage` — measured, neutral, calm-advisor
          // timbre. Chosen after A/B-ing the full modern set (marin,
          // cedar, verse, ash, coral, ballad, sage) against the
          // Kitchen Copilot persona: a non-theatrical assistant
          // that has to read prices, MOQs, and slot times cleanly
          // without sounding like a barista or a podcast host.
          // Override via opts.voice if you're experimenting.
          voice: opts.voice ?? "sage",
          speed: opts.speed ?? 1.0,
        },
      },
    },
  };
}
