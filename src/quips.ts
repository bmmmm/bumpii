// SPDX-License-Identifier: GPL-3.0-or-later
// What the progress line says while it waits.
//
// The line is decoration, but it is decoration on a tool whose whole point is
// not to state things it has not checked — so a quip is not a random string.
// Every one of them carries a predicate over the run's measured state and is
// only eligible while that predicate holds. "34 changelogs" appears when the
// run really is holding thirty-four; "one repo, one question" only when there
// is exactly one. A quip that would need a number the run has not counted yet
// simply is not a candidate.
//
// Rotation is by elapsed time, not by chance: the same run in the same state
// says the same thing at the same second, which is what makes this testable.
//
// The same rule applies to constants: a quip that quotes a timeout or a
// concurrency imports it or is handed it, never repeats the literal. The first
// draft of this file told the user probes "get 5 seconds each" when they get
// ten, which is exactly the kind of confidently wrong line this tool is built
// not to print.
import { PROBE_TIMEOUT_MS } from "./version.ts";

/** Which part of a command is running. The line's fallback text, too. */
export type Phase =
  | "config"
  | "engine"
  | "brew"
  | "probe"
  | "fetch"
  | "judge"
  | "grep"
  | "notifications"
  | "discover"
  | "update";

/**
 * Everything a quip may speak about. Anything absent is unknown — not zero —
 * and a quip that names it must say so in its predicate.
 */
export interface QuipState {
  phase: Phase;
  /** Seconds since the progress line appeared. */
  elapsed: number;
  /** Units of work in this phase, when the phase knows its own size. */
  total?: number;
  /** Units finished. Never rendered without a `total` to make sense of it. */
  done?: number;
  /** Tools, formulae or containers this command ranges over. */
  tools?: number;
  /**
   * Pending releases counted so far, summed across every tool — not one
   * tool's backlog. Any quip naming it has to make that clear or pair it with
   * `tools`, or it overstates how far behind any single thing is.
   */
  releases?: number;
  /** Usage roots being searched. */
  roots?: number;
  /** Commands extracted from release notes, which is what gets grepped. */
  commands?: number;
  /** Which engine resolved, once it has. */
  engine?: "openai" | "claude-cli" | "none";
  /** How many judges may run at once, from whoever set the limiter. */
  concurrency?: number;
}

interface Quip {
  phase: Phase;
  /** Only eligible while this holds. */
  when: (s: QuipState) => boolean;
  text: (s: QuipState) => string;
}

/** Reads as a count of things, not as a plural typo at 1. */
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The pool. Order matters only in that a run cycles through the eligible ones
 * in this order; the first entry of each phase is deliberately the plainest,
 * so the first thing anyone sees is the boring true one.
 */
const QUIPS: Quip[] = [
  // -- reading the config ------------------------------------------------
  { phase: "config", when: () => true, text: () => "reading tools.json" },

  // -- working out what can judge ----------------------------------------
  { phase: "engine", when: () => true, text: () => "looking for something that can read" },
  {
    phase: "engine",
    when: (s) => s.elapsed >= 4,
    text: () => "asking a model server whether it is awake",
  },
  {
    phase: "engine",
    when: (s) => s.elapsed >= 12,
    text: () => "the model server is thinking about whether it is awake",
  },

  // -- brew --------------------------------------------------------------
  { phase: "brew", when: () => true, text: () => "asking brew what it has been sitting on" },
  {
    phase: "brew",
    when: (s) => s.elapsed >= 6,
    text: () => "brew is thinking. brew is usually thinking",
  },

  // -- probing installed versions ----------------------------------------
  { phase: "probe", when: () => true, text: () => "asking binaries how old they are" },
  {
    phase: "probe",
    when: (s) => s.tools !== undefined && s.tools > 1,
    text: (s) => `asking ${plural(s.tools ?? 0, "binary", "binaries")} how old they are`,
  },
  {
    phase: "probe",
    when: (s) => s.elapsed >= PROBE_TIMEOUT_MS / 1000,
    text: () => `one of them is not answering. they get ${PROBE_TIMEOUT_MS / 1000} seconds each`,
  },

  // -- fetching release notes --------------------------------------------
  { phase: "fetch", when: () => true, text: () => "reading changelogs nobody reads" },
  {
    phase: "fetch",
    when: (s) => s.tools === 1,
    text: () => "one repo, one question",
  },
  {
    phase: "fetch",
    when: (s) => (s.releases ?? 0) > 3,
    text: (s) => `${plural(s.releases ?? 0, "release", "releases")} of notes, and counting`,
  },
  {
    phase: "fetch",
    // Both numbers, because `releases` is the total across everything being
    // read — "36 releases behind" on its own reads as one tool thirty-six
    // behind, which is a different and much more alarming claim than the run
    // ever made.
    when: (s) => (s.releases ?? 0) > 20 && (s.tools ?? 0) > 1,
    text: (s) => `${s.releases} releases across ${s.tools} tools. someone stopped looking a while ago`,
  },
  {
    phase: "fetch",
    when: (s) => s.elapsed >= 15,
    text: () => "the forge is rate limiting somebody. possibly us",
  },

  // -- judging -----------------------------------------------------------
  { phase: "judge", when: () => true, text: () => "the model forms an opinion" },
  {
    phase: "judge",
    when: (s) => s.engine === "openai",
    text: () => "your laptop is thinking, one release at a time",
  },
  {
    phase: "judge",
    when: (s) => s.engine === "claude-cli",
    text: () => "haiku is reading so you do not have to",
  },
  {
    phase: "judge",
    // Both numbers come from the run: the size of the queue, and the width the
    // limiter was actually built with.
    when: (s) => s.concurrency !== undefined && (s.total ?? 0) > s.concurrency,
    text: (s) => `${plural(s.total ?? 0, "tool", "tools")} to read up on, ${s.concurrency} at a time`,
  },
  {
    phase: "judge",
    when: (s) => s.elapsed >= 30,
    text: () => "this is the slow part. it was always the slow part",
  },
  {
    phase: "judge",
    when: (s) => s.elapsed >= 90,
    text: () => "a local model is cheaper than an API and slower than both",
  },

  // -- grepping your files -----------------------------------------------
  { phase: "grep", when: () => true, text: () => "grepping your files for any of this" },
  {
    phase: "grep",
    when: (s) => s.commands !== undefined && s.roots !== undefined && s.commands > 0,
    text: (s) => `${plural(s.commands ?? 0, "command", "commands")} against ${s.roots} of your trees`,
  },
  {
    phase: "grep",
    when: (s) => s.commands === 0,
    text: () => "no commands came out of the notes — nothing to grep for",
  },

  // -- github notifications ----------------------------------------------
  { phase: "notifications", when: () => true, text: () => "reading your unread release notifications" },
  {
    phase: "notifications",
    when: (s) => (s.total ?? 0) > 0,
    text: (s) => `${plural(s.total ?? 0, "notification", "notifications")} that survived the filter`,
  },

  // -- add / scan --------------------------------------------------------
  { phase: "discover", when: () => true, text: () => "working out what these actually are" },
  {
    phase: "discover",
    when: (s) => (s.tools ?? 0) > 1,
    text: (s) => `${plural(s.tools ?? 0, "name", "names")}, each needing a version and a repo`,
  },

  // -- running the update lines -----------------------------------------
  { phase: "update", when: () => true, text: () => "running the update line" },
  {
    phase: "update",
    when: (s) => s.elapsed >= 20,
    text: () => "brew is compiling something. it does that",
  },
];

/** Every quip that is true of this state right now, plainest first. */
export function eligible(state: QuipState): string[] {
  return QUIPS.filter((q) => q.phase === state.phase && q.when(state)).map((q) => q.text(state));
}

/** How long one quip stays on screen before the next eligible one takes over. */
export const QUIP_SECONDS = 4;

/**
 * The quip for this state at this moment.
 *
 * Rotation is a function of elapsed time so that it is reproducible: no
 * randomness, no hidden counter, and a test can ask what the line says at
 * second 9 of a given state. The eligible set can grow mid-phase (a predicate
 * turning true as work is counted), which simply widens the rotation from
 * there on.
 */
export function quipFor(state: QuipState): string {
  const options = eligible(state);
  if (options.length === 0) return state.phase;
  const step = Math.floor(Math.max(0, state.elapsed) / QUIP_SECONDS);
  return options[step % options.length] as string;
}
