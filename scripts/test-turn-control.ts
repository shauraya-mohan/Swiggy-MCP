#!/usr/bin/env tsx
// Offline tests for lib/agent/turn-control.
//
// These guard the wire-level sequence and ordering of audio-pipeline
// calls across the push-to-talk turn machine. The bugs they catch are
// the subtle "I added a pause() and now the WebRTC jitter buffer fills
// during interrupt → next turn replays the cancelled response" class.
//
// Run: `npm run test:turn-control`

import {
  armForInterrupt,
  armForListening,
  armForResponse,
  type TurnControlHandle,
} from "../lib/agent/turn-control";

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

function group(name: string) {
  console.log(`\n${Y}${name}${X}`);
}

interface HandleSpy {
  handle: TurnControlHandle;
  /** Ordered log of every call made on the handle: "method(arg)". */
  calls: string[];
}

function makeHandleSpy(): HandleSpy {
  const calls: string[] = [];
  const handle: TurnControlHandle = {
    send: (event) => {
      // Just the type — payload for response.cancel is empty anyway.
      calls.push(`send(${event.type})`);
    },
    setMicEnabled: (on) => {
      calls.push(`setMicEnabled(${on})`);
    },
    setPlaybackMuted: (muted) => {
      calls.push(`setPlaybackMuted(${muted})`);
    },
    setReceiverAudioEnabled: (enabled) => {
      calls.push(`setReceiverAudioEnabled(${enabled})`);
    },
  };
  return { handle, calls };
}

// =========================================================================
//  1. armForInterrupt — kill audio at source AND destination, then cancel
// =========================================================================

group("1. armForInterrupt");

{
  const { handle, calls } = makeHandleSpy();
  armForInterrupt(handle);

  assert(calls.length === 3, "issues exactly 3 calls", `got ${calls.length}`);

  assert(
    calls[0] === "setReceiverAudioEnabled(false)",
    "FIRST call disables the receiver (source-level silence)",
    `got: ${calls[0]}`,
  );

  assert(
    calls[1] === "setPlaybackMuted(true)",
    "SECOND call mutes playback (audioEl.muted = true)",
    `got: ${calls[1]}`,
  );

  assert(
    calls[2] === "send(response.cancel)",
    "THIRD call sends response.cancel",
    `got: ${calls[2]}`,
  );

  // Critical regression guard: the audio pipeline MUST be silenced before
  // we send response.cancel. If response.cancel went first, OpenAI's
  // round-trip would leave a ~200ms window where new audio could play.
  assert(
    calls.indexOf("setPlaybackMuted(true)") <
      calls.indexOf("send(response.cancel)"),
    "playback muted BEFORE response.cancel (no 200ms leak window)",
  );

  // Critical regression guard: the receiver MUST be disabled before
  // gain → 0. If gain went first, in-flight audio could still hit the
  // analyser briefly and flicker the Aura back to "speaking".
  assert(
    calls.indexOf("setReceiverAudioEnabled(false)") <
      calls.indexOf("setPlaybackMuted(true)"),
    "receiver disabled BEFORE playback mute (no analyser flicker)",
  );

  // armForInterrupt MUST NEVER unmute or re-enable anything — that
  // would defeat the whole purpose of an interrupt.
  assert(
    !calls.includes("setPlaybackMuted(false)"),
    "never un-mutes playback during interrupt",
  );
  assert(
    !calls.some((c) => c === "setReceiverAudioEnabled(true)"),
    "never re-enables the receiver during interrupt",
  );

  // Must not enable mic either (user hasn't asked to talk yet).
  assert(
    !calls.some((c) => c.startsWith("setMicEnabled")),
    "does not touch the mic during interrupt",
  );
}

// =========================================================================
//  2. armForListening — open the floor, leave playback as-is
// =========================================================================

group("2. armForListening");

{
  const { handle, calls } = makeHandleSpy();
  armForListening(handle);

  assert(calls.length === 2, "issues exactly 2 calls", `got ${calls.length}`);

  assert(
    calls[0] === "setMicEnabled(true)",
    "FIRST call enables the mic",
    `got: ${calls[0]}`,
  );

  assert(
    calls[1] === "send(input_audio_buffer.clear)",
    "SECOND call clears the input buffer (fresh utterance)",
    `got: ${calls[1]}`,
  );

  // THE LOAD-BEARING REGRESSION GUARD for the user-reported bug:
  //
  // If startListening (which calls armForListening) ever re-enabled the
  // audio pipeline, leftover audio from a prior interrupted response
  // would start playing the moment the user tapped Tap-to-Talk. The
  // user reported exactly this. armForListening MUST stay completely
  // hands-off the playback path.
  assert(
    !calls.some((c) => c.startsWith("setPlaybackMuted")),
    "NEVER touches setPlaybackMuted (audio stays muted from interrupt)",
  );
  assert(
    !calls.some((c) => c.startsWith("setReceiverAudioEnabled")),
    "NEVER touches setReceiverAudioEnabled (receiver stays disabled)",
  );
  assert(
    !calls.some((c) => c === "send(response.create)"),
    "NEVER sends response.create (user hasn't committed a turn yet)",
  );
}

// =========================================================================
//  3. armForResponse — close mic, re-arm playback, commit, respond
// =========================================================================

group("3. armForResponse");

{
  const { handle, calls } = makeHandleSpy();
  armForResponse(handle);

  assert(calls.length === 5, "issues exactly 5 calls", `got ${calls.length}`);

  assert(
    calls[0] === "setMicEnabled(false)",
    "FIRST call disables the mic (turn over)",
    `got: ${calls[0]}`,
  );

  assert(
    calls[1] === "setReceiverAudioEnabled(true)",
    "SECOND call re-enables the receiver",
    `got: ${calls[1]}`,
  );

  assert(
    calls[2] === "setPlaybackMuted(false)",
    "THIRD call un-mutes playback (audioEl.muted = false)",
    `got: ${calls[2]}`,
  );

  assert(
    calls[3] === "send(input_audio_buffer.commit)",
    "FOURTH call commits the input buffer",
    `got: ${calls[3]}`,
  );

  assert(
    calls[4] === "send(response.create)",
    "FIFTH call asks for a response",
    `got: ${calls[4]}`,
  );

  // Critical regression guards on order:

  // The audio pipeline MUST be open before we send response.create.
  // If response.create went first, the model's `response.created` event
  // could land while gain is still 0, and the first audio delta would
  // play silently.
  assert(
    calls.indexOf("setPlaybackMuted(false)") <
      calls.indexOf("send(response.create)"),
    "gain un-muted BEFORE response.create",
  );
  assert(
    calls.indexOf("setReceiverAudioEnabled(true)") <
      calls.indexOf("send(response.create)"),
    "receiver re-enabled BEFORE response.create",
  );

  // Receiver before gain (mirror of interrupt order):
  assert(
    calls.indexOf("setReceiverAudioEnabled(true)") <
      calls.indexOf("setPlaybackMuted(false)"),
    "receiver re-enabled BEFORE playback un-mutes",
  );

  // Mic off BEFORE response.create, so OpenAI doesn't get a few extra
  // milliseconds of user audio after the commit.
  assert(
    calls.indexOf("setMicEnabled(false)") <
      calls.indexOf("send(input_audio_buffer.commit)"),
    "mic disabled BEFORE commit",
  );
}

// =========================================================================
//  4. End-to-end turn sequence (the bug the user reported)
// =========================================================================

group("4. interrupt → tap-to-talk → tap-to-send (user scenario)");

{
  // Reproduce the exact sequence the user reported:
  //   1. Agent is speaking ("biryani")
  //   2. User clicks Interrupt
  //   3. User clicks Tap to Talk
  //   4. User says "lets order some pasta"
  //   5. User clicks Send
  //
  // The audio pipeline must transition: ON → OFF → (stays OFF through
  // listening) → ON.
  const { handle, calls } = makeHandleSpy();

  armForInterrupt(handle); // (2)
  const afterInterrupt = calls.length;

  armForListening(handle); // (3) — Tap to Talk

  // Between Tap to Talk and Send (3 → 5), the audio pipeline must be
  // completely untouched. If anything here re-enables playback, the
  // user hears the cancelled response.
  const listenCalls = calls.slice(afterInterrupt);
  assert(
    !listenCalls.some((c) => c.startsWith("setPlaybackMuted")),
    "during Tap-to-Talk phase, playback is never touched",
  );
  assert(
    !listenCalls.some((c) => c.startsWith("setReceiverAudioEnabled")),
    "during Tap-to-Talk phase, receiver is never touched",
  );

  const afterListening = calls.length;
  armForResponse(handle); // (5) — Tap to Send

  // The full sequence should show: pipeline OFF before listen, pipeline
  // ON only at the very end (just before response.create).
  const muteIndex = calls.indexOf("setPlaybackMuted(true)");
  const unmuteIndex = calls.indexOf("setPlaybackMuted(false)");
  const responseCreateIndex = calls.indexOf("send(response.create)");

  assert(muteIndex >= 0, "playback was muted (interrupt)");
  assert(unmuteIndex > muteIndex, "playback was un-muted later (send)");
  assert(
    unmuteIndex < responseCreateIndex,
    "un-mute happens before response.create",
  );

  // No "Tap to Talk re-opened the pipeline" smoking gun:
  const listenSlice = calls.slice(afterInterrupt, afterListening);
  assert(
    listenSlice.length === 2,
    "Tap-to-Talk only touches mic + buffer (2 calls)",
    `slice: ${JSON.stringify(listenSlice)}`,
  );
}

// =========================================================================
//  5. Re-interrupting back-to-back works
// =========================================================================

group("5. interrupt → interrupt (rapid taps)");

{
  // User mashes Interrupt twice in quick succession. Both should silence
  // the pipeline harmlessly; the second is essentially a no-op at the
  // wire level (idempotent).
  const { handle, calls } = makeHandleSpy();
  armForInterrupt(handle);
  armForInterrupt(handle);

  // 3 calls each = 6 total.
  assert(calls.length === 6, "two interrupts = 6 calls", `got ${calls.length}`);

  // Order within each invocation preserved.
  assert(calls[0] === "setReceiverAudioEnabled(false)", "1st interrupt: receiver off");
  assert(calls[1] === "setPlaybackMuted(true)", "1st interrupt: playback muted");
  assert(calls[2] === "send(response.cancel)", "1st interrupt: cancel");
  assert(calls[3] === "setReceiverAudioEnabled(false)", "2nd interrupt: receiver off (again)");
  assert(calls[4] === "setPlaybackMuted(true)", "2nd interrupt: playback muted (again)");
  assert(calls[5] === "send(response.cancel)", "2nd interrupt: cancel (again)");

  // No accidental "re-enable" sneaking in between the two interrupts.
  assert(
    !calls.some((c) => c === "setReceiverAudioEnabled(true)"),
    "no spurious re-enable between rapid interrupts",
  );
  assert(
    !calls.some((c) => c === "setPlaybackMuted(false)"),
    "no spurious un-mute between rapid interrupts",
  );
}

// =========================================================================
//  Summary
// =========================================================================

console.log(`\n${passed} passed${failed > 0 ? `, ${R}${failed} failed${X}` : ""}\n`);
if (failed > 0) {
  console.log(`Failures:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
