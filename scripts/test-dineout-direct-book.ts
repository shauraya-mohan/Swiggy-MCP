#!/usr/bin/env tsx
// Offline tests for the dineout direct-book flow.
//
// Covers the prompt's PATH A / PATH C behaviour:
//
//   PATH A — user named a specific time → agent calls book_table
//            directly (no get_available_slots first). The mock checks
//            whether that exact slot is free and either books or
//            returns SLOT_UNAVAILABLE.
//
//   PATH C — book_table returned SLOT_UNAVAILABLE → agent falls back
//            to get_available_slots to show alternates.
//
// The whole point of the flow: the user shouldn't see a Negotiator
// panel when they already named a workable time. The Negotiator only
// surfaces when there's genuine ambiguity (no time given, or the
// named time is taken).
//
// Run: `npm run test:dineout-direct-book`

import { book_table, get_available_slots } from "../lib/mock/dineout";
import { store } from "../lib/mock";

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

// =========================================================================
//  Setup: pin restaurant + date so we have a stable RNG seed across
//  every assertion in this file. Same seed as scripts/test-mocks.ts
//  uses for its smoke check, so when the seed changes both files
//  will fail in lockstep (and you'll know to update both).
// =========================================================================

const RESTAURANT_ID = "din_001"; // Toscano
const DATE = "2026-05-15";

// Under the seed `${restaurantId}${dateStr}` running through the
// linear-congruential generator in lib/mock/dineout.ts:generateSlots,
// the following times are KNOWN-good for din_001 + 2026-05-15:
//   12:30 LUNCH  → available
//   20:00 DINNER → UNAVAILABLE (taken)
// We pin both so PATH A (book) and PATH C (fall back) can be exercised
// deterministically. If the RNG logic ever changes, this file's
// assertions go red and the README points at lockstep updates needed
// in test-mocks.ts and test-router.ts.

const AVAILABLE_TIME = "12:30";
const UNAVAILABLE_TIME = "20:00";

// =========================================================================
//  1. Sanity — get_available_slots reflects our pinned expectations
// =========================================================================
//
// Before we assert what book_table does, confirm the per-slot
// availability we're relying on is what generateSlots actually
// produces. If this group fails, the rest of the file is meaningless.

group("1. Pinned slot availability (sanity)");

(async () => {
  const slotsRes = await get_available_slots({
    restaurantId: RESTAURANT_ID,
    date: DATE,
    guestCount: 2,
  });

  if (!slotsRes.success) {
    console.error("Could not fetch slots — aborting all assertions.");
    process.exit(1);
  }

  const slots = slotsRes.data.slots;
  const target12_30 = slots.find((s) => s.time === AVAILABLE_TIME);
  const target20_00 = slots.find((s) => s.time === UNAVAILABLE_TIME);

  assert(
    target12_30?.available === true,
    `${AVAILABLE_TIME} is available for ${RESTAURANT_ID} on ${DATE}`,
    target12_30 ? `band=${target12_30.band}` : "slot not found",
  );

  assert(
    target20_00?.available === false,
    `${UNAVAILABLE_TIME} is UNAVAILABLE for ${RESTAURANT_ID} on ${DATE}`,
    target20_00 ? `band=${target20_00.band}` : "slot not found",
  );

  // =====================================================================
  //  2. PATH A — direct book on an available time (no slotId)
  // =====================================================================
  //
  // This is the common case: user says "book Toscano for 12:30 today".
  // Agent calls book_table directly with date+time, no get_available_slots
  // beforehand. Mock should succeed without a slotId.

  group("2. PATH A — direct book on available time (no slotId)");

  store.resetAll();
  const directBook = await book_table({
    restaurantId: RESTAURANT_ID,
    guestCount: 2,
    date: DATE,
    time: AVAILABLE_TIME,
  });

  assert(directBook.success === true, "book_table succeeds without slotId");
  if (directBook.success) {
    assert(
      directBook.data.status === "CONFIRMED",
      "booking status is CONFIRMED",
      directBook.data.status,
    );
    assert(directBook.data.time === AVAILABLE_TIME, "booking carries the requested time");
    assert(
      directBook.data.date === DATE,
      "booking carries the requested date",
      directBook.data.date,
    );
    assert(
      directBook.data.slotId.startsWith("slot_"),
      "mock synthesises a slotId when caller didn't provide one",
      directBook.data.slotId,
    );
  }

  // =====================================================================
  //  3. PATH C trigger — direct book on UNAVAILABLE time
  // =====================================================================
  //
  // User says "book Toscano for 8 PM" but the 20:00 slot is taken.
  // Mock must return SLOT_UNAVAILABLE so the agent knows to fall back
  // to get_available_slots and show alternates.

  group("3. PATH C trigger — direct book on UNAVAILABLE time");

  store.resetAll();
  const blockedBook = await book_table({
    restaurantId: RESTAURANT_ID,
    guestCount: 2,
    date: DATE,
    time: UNAVAILABLE_TIME,
  });

  assert(blockedBook.success === false, "book_table fails for a taken slot");
  if (!blockedBook.success) {
    assert(
      blockedBook.error.code === "SLOT_UNAVAILABLE",
      "error code is SLOT_UNAVAILABLE (agent uses this to branch)",
      blockedBook.error.code,
    );
    assert(
      blockedBook.error.message.includes(UNAVAILABLE_TIME),
      "error message names the requested time (agent can read back)",
      blockedBook.error.message,
    );
  }

  // =====================================================================
  //  4. Out-of-service-hours time
  // =====================================================================
  //
  // Restaurants run lunch 12:00-15:30 and dinner 18:00-22:30. Calling
  // book_table for 16:00 (dead zone) or 23:30 (after close) should
  // fail with SLOT_UNAVAILABLE and an explanatory message — agent
  // tells the user "they don't serve at 4 PM".

  group("4. Out-of-service-hours time");

  for (const badTime of ["16:00", "17:00", "23:30", "06:00"]) {
    store.resetAll();
    const res = await book_table({
      restaurantId: RESTAURANT_ID,
      guestCount: 2,
      date: DATE,
      time: badTime,
    });
    assert(res.success === false, `${badTime} → fails`);
    if (!res.success) {
      assert(
        res.error.code === "SLOT_UNAVAILABLE",
        `${badTime} → SLOT_UNAVAILABLE`,
        res.error.code,
      );
      assert(
        /serve|lunch|dinner/i.test(res.error.message),
        `${badTime} → message explains service hours`,
        res.error.message,
      );
    }
  }

  // =====================================================================
  //  5. Legacy path — slotId without time (backwards compat)
  // =====================================================================
  //
  // The router test still calls book_table with slotId and time both.
  // But an older flow (or a real MCP that hands the agent a slotId
  // from get_available_slots) might pass slotId WITHOUT time. The
  // mock should fall through to "trust the slotId implicitly" — we
  // can't reverse-lookup a regenerated time from a fresh-per-call
  // slotId anyway. So no availability check happens in that case.

  group("5. Legacy path — slotId without time");

  store.resetAll();
  const legacy = await book_table({
    restaurantId: RESTAURANT_ID,
    slotId: "slot_FROM_PANEL", // hypothetically came from get_available_slots
    guestCount: 2,
    date: DATE,
    // No time — we trust the slotId.
  });

  assert(legacy.success === true, "legacy slotId-only path still works (backwards compat)");
  if (legacy.success) {
    assert(
      legacy.data.slotId === "slot_FROM_PANEL",
      "preserves the passed slotId",
      legacy.data.slotId,
    );
  }

  // =====================================================================
  //  6. PATH C end-to-end — fallback from blocked book to alternates
  // =====================================================================
  //
  // After a SLOT_UNAVAILABLE the agent calls get_available_slots with
  // the original time as `time` so the panel centres on the user's
  // preferred slot (with it dimmed) plus alternates. This test just
  // confirms the data round-trip: the panel still includes the dimmed
  // 20:00 plus 4 other slots around it.

  group("6. PATH C end-to-end — blocked book then get_available_slots(time)");

  const alternates = await get_available_slots({
    restaurantId: RESTAURANT_ID,
    date: DATE,
    guestCount: 2,
    band: "DINNER",
    time: UNAVAILABLE_TIME,
  });

  assert(alternates.success === true, "get_available_slots(band, time) succeeds");
  if (alternates.success) {
    const window = alternates.data.slots;
    assert(
      window.length === 5,
      "panel is centred to a 5-slot window around the requested time",
      `got ${window.length}`,
    );
    assert(
      window.some((s) => s.time === UNAVAILABLE_TIME && s.available === false),
      "the originally-requested time is in the window AND dimmed (available:false)",
    );
    assert(
      window.some((s) => s.available === true),
      "window contains at least one available alternate",
    );
    assert(
      window.every((s) => s.band === "DINNER"),
      "every slot in the window is in the requested band",
    );
  }

  // =====================================================================
  //  Summary
  // =====================================================================

  console.log(`\n${passed} passed${failed > 0 ? `, ${R}${failed} failed${X}` : ""}\n`);
  if (failed > 0) {
    console.log(`Failures:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})();
