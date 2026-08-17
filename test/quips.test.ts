// SPDX-License-Identifier: GPL-3.0-or-later
// The progress line is decoration, but it is decoration that speaks in
// numbers, and this codebase's one rule is that nothing states a conclusion
// the code did not reach. These tests hold the line to that: a quip may only
// name a quantity the run actually measured.
import assert from "node:assert/strict";
import test from "node:test";
import { eligible, type Phase, QUIP_SECONDS, type QuipState, quipFor } from "../src/quips.ts";
import { PROBE_TIMEOUT_MS } from "../src/version.ts";

const PHASES: Phase[] = [
  "config",
  "engine",
  "brew",
  "probe",
  "fetch",
  "judge",
  "grep",
  "notifications",
  "discover",
  "update",
];

/** Everything a long-running command would eventually know about itself. */
const full = (patch: Partial<QuipState> = {}): QuipState => ({
  phase: "fetch",
  elapsed: 0,
  total: 12,
  done: 3,
  tools: 12,
  releases: 34,
  roots: 3,
  commands: 18,
  engine: "openai",
  concurrency: 3,
  ...patch,
});

test("a quip never states a number the run has not measured", () => {
  // The state a command has in its first moments: it knows which phase it is
  // in and nothing else. Any digit printed here would be one this tool made
  // up — which is the failure mode the whole codebase is built against.
  for (const phase of PHASES) {
    for (const text of eligible({ phase, elapsed: 0 })) {
      assert.doesNotMatch(
        text,
        /\d/,
        `"${text}" (phase ${phase}) prints a number, but nothing had been counted yet`,
      );
      // The other shape of the same bug, and the one a digit check misses: a
      // predicate loose enough to let the quip through with the count still
      // unset renders "undefined releases behind" — no digits, all wrong.
      assert.doesNotMatch(
        text,
        /undefined|NaN|\[object/,
        `"${text}" (phase ${phase}) interpolated a value it did not have`,
      );
    }
  }
});

test("a quip that quotes the probe timeout quotes the real one", () => {
  // The first draft of quips.ts said probes "get 5 seconds each" while the
  // code gave them ten. The number now comes from the source of truth, so a
  // change to that timeout cannot leave a lie on screen.
  const texts = eligible({ phase: "probe", elapsed: PROBE_TIMEOUT_MS / 1000 });
  const quoted = texts.filter((t) => /\d/.test(t));
  assert.ok(quoted.length > 0, "expected the long-probe quip to be eligible at the timeout");
  for (const t of quoted) {
    assert.match(t, new RegExp(`\\b${PROBE_TIMEOUT_MS / 1000}\\b`), `"${t}" does not quote PROBE_TIMEOUT_MS`);
  }
});

test("the concurrency quip only appears once the limiter's width is known", () => {
  const withoutWidth = eligible(full({ phase: "judge", concurrency: undefined }));
  assert.ok(
    // Not /at a time/: "one release at a time" is a true sentence about a
    // local model and carries no count.
    !withoutWidth.some((t) => /\d+ at a time/.test(t)),
    "claimed a batch width while nothing had said what the width was",
  );
  const withWidth = eligible(full({ phase: "judge", concurrency: 3 }));
  assert.ok(withWidth.some((t) => t.includes("12 tools to read up on, 3 at a time")));
});

test("counts in a quip are the counts it was given", () => {
  const texts = eligible(full({ phase: "fetch", releases: 34, tools: 12 }));
  assert.ok(texts.some((t) => t.includes("34 releases")));
  // And not a stale one from a different run.
  const fewer = eligible(full({ phase: "fetch", releases: 2 }));
  assert.ok(!fewer.some((t) => t.includes("34")));
});

test("the 'someone stopped looking' quip stays away from a normal backlog", () => {
  // It is a joke about neglect. On a tool two releases behind it would simply
  // be wrong about the user.
  const normal = eligible(full({ phase: "fetch", releases: 4 }));
  assert.ok(!normal.some((t) => t.includes("stopped looking")));
  const neglected = eligible(full({ phase: "fetch", releases: 40 }));
  assert.ok(neglected.some((t) => t.includes("stopped looking")));
});

test("nothing says 'releases' about one release", () => {
  // Every count that can be 1 goes through plural(), so no line reads "1
  // releases" — the tell of a number that was formatted rather than read.
  for (const phase of PHASES) {
    for (const n of [0, 1]) {
      const state = full({ phase, releases: n, total: n, tools: n, commands: n, roots: n });
      for (const text of eligible(state)) {
        assert.doesNotMatch(text, /\b1 (releases|tools|commands|notifications|names|binaries)\b/, text);
      }
    }
  }
});

test("an empty grep says so instead of implying a search happened", () => {
  const nothing = eligible(full({ phase: "grep", commands: 0 }));
  assert.ok(nothing.some((t) => t.includes("nothing to grep")));
  // And the version that counts commands must not claim a count of zero.
  assert.ok(!nothing.some((t) => /\b0 commands\b/.test(t)));
});

test("quips rotate over time and are reproducible", () => {
  const state = full({ phase: "judge", elapsed: 0 });
  const options = eligible(state);
  assert.ok(options.length > 1, "this test needs a phase with several eligible quips");

  const first = quipFor({ ...state, elapsed: 0 });
  const second = quipFor({ ...state, elapsed: QUIP_SECONDS });
  assert.notEqual(first, second, "the line never changed, so a long wait shows one sentence forever");

  // Same state, same second, same words — no randomness anywhere in here.
  assert.equal(quipFor({ ...state, elapsed: 0 }), first);
  assert.equal(quipFor({ ...state, elapsed: QUIP_SECONDS * options.length }), first);
});

test("every phase can say something, even knowing nothing", () => {
  for (const phase of PHASES) {
    const text = quipFor({ phase, elapsed: 0 });
    assert.ok(text.length > 0, `phase ${phase} had nothing to say`);
  }
});

test("a negative or absurd clock does not crash the rotation", () => {
  // elapsed is derived from a clock, and clocks jump.
  assert.ok(quipFor(full({ elapsed: -5 })).length > 0);
  assert.ok(quipFor(full({ elapsed: Number.MAX_SAFE_INTEGER })).length > 0);
});
