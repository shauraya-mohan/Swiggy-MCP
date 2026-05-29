#!/usr/bin/env tsx
// Voice-session offline tests.
//
// We can't mint a real OpenAI ephemeral token without a key (and even with
// one, tokens expire in 1 minute — a poor signal). What we *can* validate
// without the network:
//   1. The system prompt loads from disk and covers the PRD-mandated rules.
//   2. buildSessionConfig() produces a shape OpenAI will accept.
//   3. All 35 manifest tools are present in the tools array, namespaced.
//   4. Environment overrides (OPENAI_REALTIME_MODEL) take effect.
//   5. The voice contract rules are *in the prompt* — drift detection.
//
// Run: `npm run test:voice`

import {
  buildSessionConfig,
  buildTimeContextBlock,
  loadSystemPrompt,
} from "../lib/voice/session-config";
import { TOOLS } from "../lib/mcp/manifest";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const X = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ${G}\u2713${X} ${name}${detail ? ` ${D}\u2014 ${detail}${X}` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ${R}\u2717${X} ${name}${detail ? ` ${D}\u2014 ${detail}${X}` : ""}`);
  }
}

function section(t: string): void {
  console.log(`\n${Y}${t}${X}`);
}

async function main() {
  console.log("\nKitchen Copilot voice-session tests");
  console.log(`${D}validates system prompt + session config without burning an API call${X}`);

  // -----------------------------------------------------------------------
  // 1. System prompt loads and is non-trivial
  // -----------------------------------------------------------------------
  section("System prompt — the product itself");

  const prompt = loadSystemPrompt();
  assert(prompt.length > 1500, "prompt is substantial (>1500 chars)", `${prompt.length} chars`);
  assert(prompt.includes("Kitchen Copilot"), "prompt names the assistant");
  assert(
    prompt.includes("Are we cooking tonight, ordering in, or heading out?"),
    "prompt includes the Intent Gateway opening line (PRD §3.1)",
  );

  // -----------------------------------------------------------------------
  // 2. Voice contract rules are in the prompt (drift detection)
  // -----------------------------------------------------------------------
  section("Voice contract rules present in prompt");

  const voiceContractClauses: Array<[string, RegExp]> = [
    ["max 3 items", /Maximum 3 items/i],
    ["never read IDs", /Never read IDs/i],
    ["prices spoken naturally", /prices? (spoken|naturally|naturally)/i],
    ["default to Home address", /Home address/i],
    ["confirm before mutation", /[Cc]onfirm before/],
    ["deliveryTimeSpoken preferred", /deliveryTimeSpoken/],
  ];

  for (const [label, re] of voiceContractClauses) {
    assert(re.test(prompt), `prompt encodes: ${label}`);
  }

  // -----------------------------------------------------------------------
  // 3. PRD module logic in prompt
  // -----------------------------------------------------------------------
  section("PRD module logic referenced");

  const moduleRules: Array<[string, RegExp]> = [
    ["Scout — multi-cart warning", /Multi-cart/i],
    ["Scout — ₹1000 cap awareness", /1000 cart cap|capExceeded/i],
    ["Auditor — MVQ", /Minimum Viable Quantity/i],
    ["Auditor — ₹99 minimum", /99 minimum/i],
    ["Auditor — verbal readback", /readback/i],
    ["Negotiator — ±30 min flex", /[\u00b1±]30 min|thirty min/i],
    ["Negotiator — similar vibes fallback", /[Ss]imilar.vibes|similar cuisine/i],
    ["Negotiator — pass band on time-of-day word", /band:\s*"DINNER"|band:\s*"LUNCH"/],
    ["Negotiator — ask lunch-or-dinner when ambiguous", /[Ll]unch or dinner/],
    ["Negotiator — pass time when user named an hour", /time:\s*"\d{2}:\d{2}"/],
  ];

  for (const [label, re] of moduleRules) {
    assert(re.test(prompt), `prompt covers: ${label}`);
  }

  // -----------------------------------------------------------------------
  // 3b. Time-context block — agent must know what "today" / "tonight" mean
  // -----------------------------------------------------------------------
  section("Time-context injection");

  // Pin a known date so the assertions are deterministic. The chosen
  // moment is a Wednesday afternoon — exercises both day-of-week and
  // time-of-day branches.
  const pinned = new Date("2026-05-13T15:30:00Z");
  const block = buildTimeContextBlock(pinned);

  assert(block.includes("## Current time context"), "block has the section header");
  assert(block.includes("2026-05-13"), "block includes today's ISO date");
  assert(block.includes("Wednesday"), "block names the day of the week");
  assert(/May 13, 2026/.test(block), "block includes human-readable date");
  assert(/Right now it is/.test(block), "block opens with a natural sentence the model can lean on");
  assert(block.includes("Upcoming dates"), "block lists upcoming dates for relative phrases");
  // Tomorrow (2026-05-14) and one-week-out (2026-05-20) should both be present.
  assert(block.includes("2026-05-14"), "block lists tomorrow's ISO");
  assert(block.includes("2026-05-20"), "block lists a date 7 days out");
  assert(/Thursday: 2026-05-14/.test(block), "tomorrow is correctly labelled Thursday");

  // The full loaded prompt must contain the injected block.
  const withTime = loadSystemPrompt(pinned);
  assert(withTime.endsWith(block) || withTime.endsWith(block.trimEnd()) || withTime.endsWith(`${block}\n`),
    "loadSystemPrompt appends the time-context block at the end");
  assert(withTime.includes("Kitchen Copilot") && withTime.includes("2026-05-13"),
    "loadSystemPrompt returns base prompt + time block in one string");

  // -----------------------------------------------------------------------
  // 4. Session config shape (matches GA /v1/realtime/client_secrets)
  // -----------------------------------------------------------------------
  section("Session config shape (GA /v1/realtime/client_secrets)");

  const cfg = buildSessionConfig();
  assert(cfg.session.type === "realtime", "session.type=realtime");
  assert(cfg.session.model === (process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime"), "model is gpt-realtime");
  assert(
    Array.isArray(cfg.session.output_modalities) && cfg.session.output_modalities.length === 1,
    "output_modalities has exactly one entry (GA disallows audio+text combo)",
  );
  assert(cfg.session.output_modalities[0] === "audio", "defaults to audio out so the model speaks");
  // Compare by prefix — the prompt ends with a `## Current time context`
  // block that's recomputed per call, so a strict `===` could flake at a
  // midnight rollover. The base content (everything before the time
  // block) must match exactly.
  const cfgPrompt = cfg.session.instructions;
  const fresh = loadSystemPrompt();
  const split = (s: string) => s.split("## Current time context")[0];
  assert(split(cfgPrompt) === split(fresh), "instructions base matches the loaded prompt (modulo per-call time block)");
  assert(cfgPrompt.includes("## Current time context"), "instructions include the time-context block");
  assert(cfg.session.tool_choice === "auto", "tool_choice = auto");

  // Audio config
  assert(cfg.session.audio.input.transcription.model.length > 0, "transcription model set", cfg.session.audio.input.transcription.model);
  // Default is now "manual" (push-to-talk) — client commits the buffer itself.
  assert(
    cfg.session.audio.input.turn_detection === null,
    "turn_detection defaults to null (manual / push-to-talk)",
  );
  // server_vad mode is still available via opts.turnDetection.
  const vadCfg = buildSessionConfig({ turnDetection: "server_vad" });
  assert(
    vadCfg.session.audio.input.turn_detection !== null &&
      vadCfg.session.audio.input.turn_detection.type === "server_vad",
    "opting in to server_vad produces a server_vad turn_detection block",
  );
  assert(
    vadCfg.session.audio.input.turn_detection !== null &&
      vadCfg.session.audio.input.turn_detection.interrupt_response === true,
    "server_vad mode keeps interrupt_response enabled",
  );
  assert(cfg.session.audio.input.noise_reduction.type === "far_field", "noise reduction is far_field (kitchen-friendly)");
  assert(cfg.session.audio.output.voice.length > 0, "voice is set", cfg.session.audio.output.voice);
  assert(cfg.session.audio.output.speed >= 0.25 && cfg.session.audio.output.speed <= 1.5, "speed within OpenAI bounds", `${cfg.session.audio.output.speed}`);

  // TTL
  assert(cfg.expires_after?.anchor === "created_at", "expires_after anchor is created_at");
  assert(
    cfg.expires_after !== undefined && cfg.expires_after.seconds >= 10 && cfg.expires_after.seconds <= 7200,
    "TTL within 10..7200 sec",
    `${cfg.expires_after?.seconds}s`,
  );

  // -----------------------------------------------------------------------
  // 5. Tools array — all 35, OpenAI-namespaced
  // -----------------------------------------------------------------------
  section("Tools surface — exact 35-tool exposure");

  assert(cfg.session.tools.length === TOOLS.length, `tools array has ${TOOLS.length} entries`, `${cfg.session.tools.length} exposed`);
  assert(
    cfg.session.tools.every((t) => t.type === "function"),
    "every tool is type=function (required by OpenAI Realtime)",
  );
  assert(
    cfg.session.tools.every((t) => /^(food|im|dineout)__[a-z_]+$/.test(t.name)),
    "every tool name is namespaced `server__tool`",
  );
  assert(
    cfg.session.tools.every((t) => typeof t.description === "string" && t.description.length >= 20),
    "every tool has a non-trivial description (≥20 chars)",
  );
  assert(
    cfg.session.tools.every((t) => t.parameters && typeof t.parameters === "object"),
    "every tool has a parameters JSON Schema",
  );

  const mutationsInTools = cfg.session.tools.filter((t) =>
    ["food__place_food_order", "im__checkout", "dineout__book_table"].includes(t.name),
  );
  assert(mutationsInTools.length === 3, "all 3 mutation tools present in OpenAI surface");
  assert(
    mutationsInTools.every((t) => /confirm/i.test(t.description) || /non-idempotent/i.test(t.description)),
    "mutation tool descriptions cue the model to confirm first",
  );

  // -----------------------------------------------------------------------
  // 6. Environment override
  // -----------------------------------------------------------------------
  section("Environment override");

  const orig = process.env.OPENAI_REALTIME_MODEL;
  process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-test-snapshot";
  const overridden = buildSessionConfig();
  assert(overridden.session.model === "gpt-realtime-test-snapshot", "OPENAI_REALTIME_MODEL overrides default", overridden.session.model);
  process.env.OPENAI_REALTIME_MODEL = orig;

  // -----------------------------------------------------------------------
  // 7. Options override
  // -----------------------------------------------------------------------
  section("Caller-provided overrides");

  const customized = buildSessionConfig({
    outputModalities: ["text"],
    voice: "cedar",
    speed: 1.2,
    ttlSeconds: 1800,
  });
  assert(
    customized.session.output_modalities.length === 1 && customized.session.output_modalities[0] === "text",
    "output_modalities can be narrowed to text-only (Step 7: Cartesia path)",
  );
  assert(customized.session.audio.output.voice === "cedar", "voice override applied");
  assert(customized.session.audio.output.speed === 1.2, "speed override applied");
  assert(customized.expires_after?.seconds === 1800, "TTL override applied");

  // -----------------------------------------------------------------------
  console.log("");
  if (failed === 0) {
    console.log(`${G}\u2713 ${passed} assertions across 7 voice-session checks all green.${X}\n`);
    process.exit(0);
  } else {
    console.log(`${R}\u2717 ${failed} of ${passed + failed} assertions failed:${X}`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
