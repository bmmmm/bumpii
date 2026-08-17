// SPDX-License-Identifier: GPL-3.0-or-later
// The line that proves bumpii is working rather than hung.
//
// Everything slow this tool does is silent: a forge GET, a model that may take
// three minutes over one release, `brew outdated` on a machine with four
// hundred formulae. Without a sign of life the honest answer and the crash
// look identical for the first thirty seconds, and the crash is what people
// assume.
//
// Three rules keep it from becoming a liability:
//
//   1. It writes to stderr only. stdout stays exactly what it was, so
//      `bumpii --json | jq` and `bumpii overview | grep` are untouched.
//   2. It writes nothing at all without a TTY, so a pipe, a cron job and CI
//      see byte-identical output to before.
//   3. Its counts come from the run, never from an estimate — and its words
//      come from quips.ts, where each one carries a predicate. A progress
//      line that guesses is the same failure mode as a report that guesses.
//
// One line per command, not one per step: it changes phase as the work moves,
// which is why the bounce and the version carry across phases instead of
// restarting.
import { type Phase, type QuipState, quipFor } from "./quips.ts";

export interface Progress {
  /** Move to a phase, optionally resetting what is being counted. */
  phase(phase: Phase, patch?: Partial<QuipState>): void;
  /** Update what the line may talk about. */
  set(patch: Partial<QuipState>): void;
  /** One more unit of the current phase is finished. */
  step(n?: number): void;
  /** Write to stdout without leaving half a spinner behind it. */
  out(s: string): void;
  /** The same for stderr, which is the stream the line itself lives on. */
  err(s: string): void;
  /**
   * Take the line down but keep the run's state, for output that belongs to
   * the user rather than to the spinner. `resume` picks the same ball back up
   * — same version, same height — so a command that prints a report and then
   * keeps working reads as one run interrupted, not two runs.
   */
  pause(): void;
  resume(): void;
  /** Erase the line and stop for good. Idempotent — safe on every exit path. */
  stop(): void;
}

interface Frame {
  art: string;
  /** Columns the ball jolts sideways on this frame, inside its own box. */
  shake: number;
  /** How long this frame holds. This is where the animation's pacing lives. */
  ms: number;
  /** A landing, and which part of the version it bumps. */
  hit?: "patch" | "minor";
}

/**
 * A ball falls, lands hard, and the landing bumps a version — which is the
 * one joke this tool is entitled to make.
 *
 * Timing is per frame rather than a fixed tick, because a constant tick is
 * what made the first version tiring to read: something moved every 80ms
 * forever, with nowhere for the eye to rest. A real ball does not do that. It
 * hangs at the apex, accelerates into the floor, loses height with every
 * landing and rolls to a stop — so the sequence below does too:
 *
 *   full jump → IMPACT → a lower one → a scrape → ~1.8s of rolling → *BUMP*
 *
 * The rolling stretch is the point of the whole shape: it is the part slow
 * enough to read a sentence over. It still moves, because a spinner holding
 * one frame for two seconds is indistinguishable from the hang this exists to
 * disprove — the ball just rolls instead of bouncing.
 *
 * Every frame is ART_WIDTH columns wide so the text after it never shifts;
 * `shake` moves the ball inside that box and nothing else.
 *
 * The small landings bump the patch; the shove that ends the roll bumps the
 * minor. A bigger jump is a bigger bump.
 */
export const FRAMES: Frame[] = [
  // -- the launch, decelerating towards the top --------------------------
  { art: "  ⡀  ", shake: 1, ms: 55 },
  { art: "  ⠄  ", shake: 1, ms: 75 },
  { art: "  ⠂  ", shake: 1, ms: 110 },
  { art: "  ⠁  ", shake: 1, ms: 170 },
  // Hang time: the longest frame of the jump, and what makes the drop read as
  // acceleration rather than as somebody turning the tick rate up.
  { art: "  ⠁  ", shake: 1, ms: 260 },
  // -- the fall, accelerating -------------------------------------------
  { art: "  ⠂  ", shake: 1, ms: 120 },
  { art: "  ⠄  ", shake: 1, ms: 85 },
  { art: "  ⡀  ", shake: 1, ms: 60 },
  { art: " \\▄/ ", shake: 3, ms: 80, hit: "patch" },
  { art: "·⠛⠛⠛·", shake: 2, ms: 95 },
  { art: "˙ ⠈ ˙", shake: 0, ms: 80 },
  // -- second jump: lower, quicker --------------------------------------
  { art: "  ⠂  ", shake: 1, ms: 130 },
  { art: "  ⠂  ", shake: 1, ms: 185 },
  { art: "  ⠄  ", shake: 1, ms: 90 },
  { art: "  ⡀  ", shake: 1, ms: 65 },
  { art: " ·▄· ", shake: 2, ms: 70, hit: "patch" },
  { art: " ⠛⠛⠛ ", shake: 1, ms: 80 },
  // -- third: barely off the floor --------------------------------------
  { art: "  ⠄  ", shake: 1, ms: 115 },
  { art: "  ⡀  ", shake: 1, ms: 80 },
  { art: "  ▄  ", shake: 1, ms: 65, hit: "patch" },
  // -- rolling: slow enough to read over, never actually still ----------
  { art: " ⣀   ", shake: 1, ms: 320 },
  { art: "  ⣀  ", shake: 1, ms: 380 },
  { art: "   ⣀ ", shake: 1, ms: 430 },
  { art: "  ⣀  ", shake: 1, ms: 380 },
  { art: " ⣀   ", shake: 1, ms: 340 },
  // -- and something shoves it back up ----------------------------------
  { art: " \\▄/ ", shake: 3, ms: 90, hit: "minor" },
];

/**
 * Printed width of one frame's art, and the widest jolt any frame asks for.
 *
 * Together they fix the column the sentence starts at. The jolt has to move
 * the ball without dragging the words along: shaking the whole line made the
 * quip jump four columns every landing, which is unreadable at 12 landings a
 * second-and-a-half. The ball rattles in its own box instead.
 */
export const ART_WIDTH = 5;
const MAX_SHAKE = 3;

/** Width the version field is padded to, so `v0.9.9` → `v0.10.0` shifts nothing. */
const HEAD_WIDTH = 7;

/**
 * Nothing is drawn for this long after start.
 *
 * `bumpii list` and a cached `bumpii add` finish inside it, and a spinner that
 * flashes for one frame on a command that was never slow is worse than none.
 */
const WARMUP_MS = 220;

/** Elapsed seconds are only shown once waiting is the story. */
const CLOCK_AFTER_S = 3;

/**
 * Whether a progress line may be drawn at all.
 *
 * stderr, not stdout: the report is piped far more often than it is watched,
 * and a spinner is for the person watching. CI and TERM=dumb opt out because
 * neither can erase a line — the animation would arrive as a thousand lines of
 * scrollback. NO_COLOR is deliberately not consulted here: it asks for no
 * colour, which is honoured below, not for no output.
 */
function enabled(): boolean {
  if (process.env.BUMPII_NO_PROGRESS) return false;
  if (process.env.CI) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stderr.isTTY);
}

const useColor = (): boolean => !process.env.NO_COLOR;
const paint = (code: string, s: string): string => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);

/** A progress object that does nothing, for every path without a terminal. */
const SILENT: Progress = {
  phase: () => {},
  set: () => {},
  step: () => {},
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
  pause: () => {},
  resume: () => {},
  stop: () => {},
};

class TtyProgress implements Progress {
  private state: QuipState = { phase: "config", elapsed: 0 };
  private started = Date.now();
  private frame = 0;
  /** Bumped on every landing. Starts where a fresh package starts. */
  private version = { major: 0, minor: 1, patch: 0 };
  private timer: NodeJS.Timeout | null = null;
  /** Nothing is drawn before this instant — see WARMUP_MS. */
  private drawAfter = Date.now() + WARMUP_MS;
  private drawn = false;
  private stopped = false;
  private restoreCursor: (() => void) | null = null;

  constructor() {
    this.arm();

    // A hidden cursor that survives the process is a broken terminal, and
    // Ctrl-C during a three-minute judge is the normal way to leave this.
    const restore = () => {
      if (this.drawn) process.stderr.write("\x1b[?25h");
    };
    this.restoreCursor = restore;
    process.on("exit", restore);
  }

  /**
   * A chain of timeouts, not an interval: each frame states how long it holds,
   * which is what lets the ball hang at the top and roll slowly at the bottom.
   * An interval can only ever offer one speed.
   */
  private arm(delay = 0): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
    // Without this the pending timer alone keeps the event loop alive and
    // every command hangs at exit instead of returning.
    this.timer.unref();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.erase();
    if (this.drawn) {
      process.stderr.write("\x1b[?25h");
      this.drawn = false;
    }
  }

  pause(): void {
    this.disarm();
  }

  resume(): void {
    if (this.stopped) return;
    // The warm-up applies again: whatever follows a report may itself finish
    // instantly, and one frame flashed under a finished report is noise.
    this.drawAfter = Date.now() + WARMUP_MS;
    this.arm(0);
  }

  phase(phase: Phase, patch: Partial<QuipState> = {}): void {
    // done/total belong to the phase that was counting them; carrying them
    // into the next one would show 7/12 against work of a different size.
    this.state = { ...this.state, done: undefined, total: undefined, ...patch, phase };
  }

  set(patch: Partial<QuipState>): void {
    this.state = { ...this.state, ...patch };
  }

  step(n = 1): void {
    this.state.done = (this.state.done ?? 0) + n;
  }

  out(s: string): void {
    this.erase();
    process.stdout.write(s);
  }

  err(s: string): void {
    this.erase();
    process.stderr.write(s);
  }

  stop(): void {
    if (this.stopped) return;
    this.disarm();
    this.stopped = true;
    if (this.restoreCursor) process.removeListener("exit", this.restoreCursor);
    this.restoreCursor = null;
  }

  /** Clear whatever is on the current line, leaving the cursor at column 0. */
  private erase(): void {
    if (this.drawn) process.stderr.write("\r\x1b[K");
  }

  private tick(): void {
    if (this.stopped) return;
    const f = FRAMES[this.frame % FRAMES.length] as Frame;
    // Still in the warm-up: keep the chain alive without drawing, so a command
    // that turns out to be slow picks the bounce up mid-stride rather than
    // starting it late.
    if (Date.now() < this.drawAfter) {
      this.arm(f.ms);
      return;
    }
    const elapsed = Date.now() - this.started;
    if (!this.drawn) {
      process.stderr.write("\x1b[?25l");
      this.drawn = true;
    }
    if (f.hit) this.bump(f.hit);
    this.frame++;
    process.stderr.write(`\r\x1b[K${this.render(f, elapsed / 1000)}`);
    this.arm(f.ms);
  }

  /**
   * Semver, rolled over properly — 0.9.9 lands on 1.0.0, as it should.
   *
   * A scrape off the floor is a patch; the shove that ends the roll is a
   * minor, and a minor resets the patch the way a real release would.
   */
  private bump(kind: "patch" | "minor"): void {
    if (kind === "minor") {
      this.version.patch = 0;
      this.version.minor++;
    } else {
      this.version.patch++;
      if (this.version.patch > 9) {
        this.version.patch = 0;
        this.version.minor++;
      }
    }
    if (this.version.minor > 9) {
      this.version.minor = 0;
      this.version.major++;
    }
  }

  private render(f: Frame, elapsedS: number): string {
    this.state.elapsed = elapsedS;
    const v = `v${this.version.major}.${this.version.minor}.${this.version.patch}`;
    // Same width either way, so the sentence after it does not jump on impact.
    const head = f.hit ? paint("1;33", "*BUMP*".padEnd(HEAD_WIDTH)) : paint("2", v.padEnd(HEAD_WIDTH));
    // The jolt lives inside a fixed-width box: pad on the left to move, pad on
    // the right by the remainder so the column after it never moves.
    const art = `${" ".repeat(f.shake)}${paint(f.hit ? "1;33" : "33", f.art)}${" ".repeat(MAX_SHAKE - f.shake)}`;
    const { done, total } = this.state;
    const count = total !== undefined && total > 0 ? paint("2", ` ${done ?? 0}/${total}`) : "";
    const secs = Math.floor(elapsedS);
    const clock = secs >= CLOCK_AFTER_S ? paint("2", ` ${secs}s`) : "";
    const line = `${art} ${head} ${paint("2", quipFor(this.state))}${count}${clock}`;
    // `|| 80`, not `?? 80`: a terminal that reports zero columns (a pty with
    // no size attached, which is what a CI shell or `script` hands you) is
    // saying it does not know, not that it is eight columns wide. Read as a
    // real width it truncated every frame to the bounce and cut the sentence
    // off entirely.
    return clamp(line, process.stderr.columns || 80);
  }
}

/**
 * Cut a line to the terminal's width, counting only what is printed.
 *
 * A line wider than the terminal wraps, and `\r\x1b[K` then erases the last
 * row of it only — leaving the rest of every frame on screen. That failure
 * looks exactly like the animation exploding, so the escapes have to be
 * measured out before deciding where to cut.
 */
export function clamp(line: string, columns: number): string {
  const limit = Math.max(8, columns - 1);
  let visible = 0;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\x1b") {
      const end = line.indexOf("m", i);
      if (end !== -1) {
        out += line.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (visible >= limit) return `${out}\x1b[0m`;
    out += line[i];
    visible++;
  }
  return out;
}

/**
 * Start the one progress line for this command.
 *
 * One per run, handed down through the work rather than started per step: the
 * ball keeps its height and the version keeps its number across phases, so a
 * long command reads as one thing taking a while instead of six things each
 * starting from scratch.
 */
export function startProgress(): Progress {
  return enabled() ? new TtyProgress() : SILENT;
}
