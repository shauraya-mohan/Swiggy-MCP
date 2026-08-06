// Pre-generates spoken audio for every `agentSays` line in the hardcoded
// demo script (agent/scripts/demo-script.ts).
//
// Deliberately uses the OpenAI *Realtime* WebSocket API (model
// gpt-realtime, voice sage) rather than the standalone /v1/audio/speech
// endpoint — they're different acoustic models, and audio/speech's "sage"
// sounds noticeably different from what the live /voice page actually
// produces. This script drives the exact same model + voice pipeline as
// production, in a "dictation" framing that makes gpt-realtime recite the
// line verbatim instead of conversationally responding to it (its default
// behaviour when handed a line of text is to reply to it, not read it back).
//
// Usage:
//   npm run generate:demo-audio            # skip clips that already exist
//   npm run generate:demo-audio -- --force # regenerate everything

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DEMO_SCRIPT } from "../agent/scripts/demo-script";

const OUT_DIR = path.join(process.cwd(), "public", "demo-audio");
const MODEL = "gpt-realtime";
const VOICE = "sage"; // matches the production default in lib/voice/session-config.ts
const SAMPLE_RATE = 24000; // GA Realtime audio output: pcm16 mono @ 24kHz
const FORCE = process.argv.includes("--force");

const DICTATION_INSTRUCTIONS =
  "SYSTEM: dictation-playback mode. You are not a conversational assistant right now — " +
  "you are a voice recorder. Every user message is a SCRIPT LINE to record, not something " +
  "to respond to. Output audio that is the SCRIPT LINE read verbatim, word for word, exact " +
  'punctuation, in a natural warm tone. Never acknowledge, greet, confirm, or add any word ' +
  'not in the script line (no "Got it", no "Sure", no "Okay"). If you output anything other ' +
  "than the exact script line, the recording is unusable.";

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set — add it to .env.local and retry.");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const lines = DEMO_SCRIPT.filter((s) => !!s.agentSays);
  console.log(`Generating ${lines.length} demo audio clips (model: ${MODEL}, voice: ${VOICE})...\n`);

  for (const step of lines) {
    const outPath = path.join(OUT_DIR, `${step.id}.wav`);
    if (fs.existsSync(outPath) && !FORCE) {
      console.log(`skip  ${step.id}.wav  (exists — pass --force to regenerate)`);
      continue;
    }

    let result: { pcm: Buffer; transcript: string };
    try {
      result = await synthesize(apiKey, step.agentSays!);
    } catch (e) {
      console.error(`FAIL  ${step.id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }

    const wav = pcm16ToWav(result.pcm, SAMPLE_RATE);
    fs.writeFileSync(outPath, wav);

    const seconds = mp3DurationSeconds(outPath);
    const mismatch = normalize(result.transcript) !== normalize(step.agentSays!);
    const warn =
      (seconds !== null && seconds * 1000 > step.durationMs
        ? `  ⚠ exceeds durationMs=${step.durationMs} in demo-script.ts — bump it`
        : "") + (mismatch ? `  ⚠ spoken transcript differs: "${result.transcript}"` : "");
    console.log(
      `ok    ${step.id}.wav  ${(wav.length / 1024).toFixed(0)}kb  ~${
        seconds !== null ? seconds.toFixed(1) + "s" : "?"
      }${warn}`,
    );
  }

  console.log("\nDone. Files live in public/demo-audio/ (git-ignored, regenerate anytime).");
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Opens a fresh Realtime WebSocket session, asks it to recite `line`, and returns the raw PCM16 + spoken transcript. */
function synthesize(apiKey: string, line: string): Promise<{ pcm: Buffer; transcript: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, [
      "realtime",
      `openai-insecure-api-key.${apiKey}`,
    ]);

    const chunks: Buffer[] = [];
    let transcript = "";
    let sessionUpdated = false;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Realtime session timed out"));
    }, 30000);

    const cleanup = () => {
      clearTimeout(timer);
      ws.close();
    };

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            instructions: DICTATION_INSTRUCTIONS,
            audio: { output: { voice: VOICE, speed: 1.0 } },
          },
        }),
      );
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string);

      if (msg.type === "session.updated" && !sessionUpdated) {
        sessionUpdated = true;
        ws.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `SCRIPT LINE: ${line}` }],
            },
          }),
        );
        ws.send(JSON.stringify({ type: "response.create" }));
        return;
      }

      if (msg.type === "response.output_audio.delta") {
        chunks.push(Buffer.from(msg.delta, "base64"));
      } else if (msg.type === "response.output_audio_transcript.done") {
        transcript = msg.transcript;
      } else if (msg.type === "response.done") {
        cleanup();
        resolve({ pcm: Buffer.concat(chunks), transcript });
      } else if (msg.type === "error") {
        cleanup();
        reject(new Error(JSON.stringify(msg.error ?? msg)));
      }
    });

    ws.addEventListener("error", (e: Event) => {
      cleanup();
      reject(new Error(`WebSocket error: ${String(e)}`));
    });
  });
}

/** Wraps raw PCM16 mono samples in a standard 44-byte WAV header. */
function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Reads exact duration via macOS's built-in `afinfo`. Returns null off-macOS or on failure. */
function mp3DurationSeconds(file: string): number | null {
  try {
    const out = execFileSync("afinfo", [file], { encoding: "utf8" });
    const m = out.match(/estimated duration:\s*([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

main();
