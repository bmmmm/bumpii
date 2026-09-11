// SPDX-License-Identifier: GPL-3.0-or-later
// The progress line is decoration, but it is decoration that speaks in
// numbers, and this codebase's one rule is that nothing states a conclusion
// the code did not reach. These tests hold the line to that: a quip may only
// name a quantity the run actually measured.
import assert from "node:assert/strict";
import test from "node:test";
import { eligible, type Phase, QUIP_SECONDS, type QuipState, quipFor } from "../src/quips.ts";
import { PROBE_TIMEOUT_MS } from "../src/version.ts";

/**
 * Every member of the `Phase` union, which TypeScript checks exhaustively: add
 * a phase to quips.ts and this object stops compiling until it is named here,
 * which is what makes the test below able to see it at all.
 */
const ALL_PHASES = Object.keys({
  config: 0,
  engine: 0,
  brew: 0,
  probe: 0,
  fetch: 0,
  judge: 0,
  grep: 0,
  notifications: 0,
  discover: 0,
  update: 0,
  reprobe: 0,
  recheck: 0,
} satisfies Record<Phase, number>) as Phase[];

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
  "reprobe",
  "recheck",
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

test("every phase a quip speaks for is inside the gate above", () => {
  // PHASES is hand-written and the gates below only ever see what is in it, so
  // a phase added to quips.ts without a line here is a phase nothing checks.
  //
  // Probed with a SATURATED state, not an empty one: a quip whose predicate
  // needs measured numbers yields nothing for `{phase, elapsed: 0}`, so an
  // emptiness check skipped precisely the phases most able to print a number
  // they made up. Measured: a quip `${s.total} leftovers` under a phase left
  // out of PHASES passed the entire suite.
  for (const phase of ALL_PHASES) {
    if (eligible(full({ phase })).length === 0) continue;
    assert.ok(
      PHASES.includes(phase),
      `quips.ts speaks for "${phase}", which PHASES does not list — the gates never see it`,
    );
  }
  // The helper has to find quips at all, or the loop above proves nothing.
  assert.ok(ALL_PHASES.some((phase) => eligible(full({ phase })).length > 0));
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

test("the update phase never says what a command is doing", () => {
  // "brew is compiling something" stood here through a run that poured nine
  // bottles and compiled nothing — a claim about the child that nothing had
  // measured. A streamed command owns the terminal anyway; what this line may
  // say is how many update lines there are, and only once that was counted.
  for (const elapsed of [0, 25, 300]) {
    for (const text of eligible({ phase: "update", elapsed })) {
      assert.doesNotMatch(text, /compil|brew|pour|download/i, `"${text}" describes a command nobody watched`);
    }
  }
  const counted = eligible(full({ phase: "update", total: 3, elapsed: 25 }));
  assert.ok(
    counted.some((t) => t.includes("3 update lines")),
    `a counted phase should be able to say its count: ${counted.join(" | ")}`,
  );
  const single = eligible(full({ phase: "update", total: 1, elapsed: 25 }));
  assert.ok(!single.some((t) => /\b1 update line/.test(t)), "one line is not a queue worth announcing");
});

test("the re-probe phase counts what it re-reads, not what the fetch counted", () => {
  // Reusing the probe phase after the updates put "asking 12 binaries" on the
  // line for two re-probes, and "one of them is not answering" the moment the
  // whole run had lasted ten seconds. Its own phase speaks of its own count.
  const late = full({ phase: "reprobe", elapsed: 300, tools: 12, total: 2 });
  const texts = eligible(late);
  assert.ok(
    texts.some((t) => t.includes("2 tools to read again")),
    `the re-probe count is what this phase measured: ${texts.join(" | ")}`,
  );
  for (const t of texts)
    assert.doesNotMatch(t, /12|not answering|binaries/, `"${t}" speaks of another phase`);
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
