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

/** Built-in voices. marin and cedar are recommended for best quality. */
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
 *  - ["audio"] : model speaks; also emits a transcript stream
 *  - ["text"]  : model emits text only; pair with external TTS (e.g. Cartesia)
 */
export type RealtimeModality = "audio" | "text";

export interface SessionConfigOptions {
  /** Default ["audio"]. Flip to ["text"] when Cartesia TTS lands in Step 7. */
  outputModalities?: RealtimeModality[];
  voice?: RealtimeVoice;
  /** 1.0 default, 0.25..1.5 allowed. */
  speed?: number;
  /** Seconds the client secret is valid for. 10..7200. */
  ttlSeconds?: number;
}

let cachedPrompt: string | null = null;

/** Load the system prompt from disk once per process. */
export function loadSystemPrompt(): string {
  if (cachedPrompt) return cachedPrompt;
  const p = path.join(process.cwd(), "agent", "prompts", "system.md");
  cachedPrompt = fs.readFileSync(p, "utf-8");
  return cachedPrompt;
}

// =========================================================================
// GA shape — exactly matches POST /v1/realtime/client_secrets body
// =========================================================================

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
        turn_detection: {
          type: "server_vad";
          threshold: number;
          prefix_padding_ms: number;
          silence_duration_ms: number;
          create_response: boolean;
          interrupt_response: boolean;
        };
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
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            // The agent should yield mid-sentence when the user starts talking.
            interrupt_response: true,
          },
          // The user is talking to a laptop/phone mic from across the kitchen —
          // far_field tolerates ambient noise (extractor fan, running water).
          noise_reduction: { type: "far_field" },
        },
        output: {
          voice: opts.voice ?? "marin",
          speed: opts.speed ?? 1.0,
        },
      },
    },
  };
}
