// SPDX-License-Identifier: GPL-3.0-or-later
// The progress line is the one thing in this tool that writes while other
// things are writing, so its failures are other commands' failures: a spinner
// frozen into a piped report, escapes in a JSON payload, a terminal left with
// no cursor. Each of those has a test here.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ART_WIDTH, clamp, FRAMES, startProgress } from "../src/progress.ts";

/**
 * Advance mocked time in small steps.
 *
 * `mock.timers.tick(5000)` runs only the timers that were already scheduled
 * when it was called — a timer the callback schedules mid-tick is not picked
 * up by that same tick. The progress line is a chain of setTimeouts, one per
 * frame, so a single big tick advances it exactly one frame and every timing
 * assertion after it measures nothing. Stepping runs the chain properly.
 */
function advance(t: TestContext, ms: number, step = 5): void {
  for (let elapsed = 0; elapsed < ms; elapsed += step) t.mock.timers.tick(step);
}

// Named rather than written as regex literals: an ESC byte inside a regex is
// a lint error here, and `HIDE_CURSOR` says what it is in a way `\x1b[?25l`
// never will.
const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ERASE_LINE = `\r${ESC}[K`;

/** Strip every escape sequence, leaving what the terminal would actually show. */
const visibleOnly = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, "g"), "");

/** Collect everything written to a stream while fn runs. */
function capture(stream: NodeJS.WriteStream, fn: () => void): string {
  const chunks: string[] = [];
  const original = stream.write;
  // biome-ignore lint/suspicious/noExplicitAny: the write overloads do not narrow here
  stream.write = ((chunk: any) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write;
  try {
    fn();
  } finally {
    stream.write = original;
  }
  return chunks.join("");
}

/**
 * Every environment variable that turns the progress line off, so a test can
 * state the tty case without the runner's own environment answering for it.
 */
const OPT_OUT_VARS = ["BUMPII_NO_PROGRESS", "CI", "TERM"] as const;

/**
 * Run fn with stderr claiming to be a terminal of the given width — and with
 * the opt-outs cleared.
 *
 * Faking `isTTY` alone is not enough, and the gap was invisible on a developer
 * machine: `enabled()` also returns false for CI, for TERM=dumb, and for
 * BUMPII_NO_PROGRESS, so under GitHub Actions (which sets CI=true) every one of
 * these tests was handed the SILENT progress object and asserted about a
 * spinner that was never supposed to draw. Six of them failed there while all
 * fourteen passed locally. Reproduce with `CI=1 node --test`.
 */
function asTty<T>(columns: number, fn: () => T): T {
  const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const cols = Object.getOwnPropertyDescriptor(process.stderr, "columns");
  const env = OPT_OUT_VARS.map((k) => [k, process.env[k]] as const);
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stderr, "columns", { value: columns, configurable: true });
  for (const [k] of env) delete process.env[k];
  try {
    return fn();
  } finally {
    if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
    if (cols) Object.defineProperty(process.stderr, "columns", cols);
    else delete (process.stderr as { columns?: number }).columns;
    for (const [k, v] of env) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("without a terminal, not one byte is written", (t) => {
  // This is what keeps `bumpii --json | jq` and every test in cli.test.ts
  // reading exactly as they did before this file existed.
  //
  // The clock has to run for this to mean anything: the first version of this
  // test called the whole API and asserted silence without ever letting a
  // frame fire, and it stayed green with the tty check deleted — it was
  // measuring that synchronous calls draw nothing, which is true of every
  // build including the broken one.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  assert.equal(process.stderr.isTTY, undefined, "the test runner is expected to have no tty");
  const written = capture(process.stderr, () => {
    const p = startProgress();
    p.phase("judge", { total: 12, done: 0 });
    p.set({ releases: 34 });
    p.step();
    advance(t, 5000);
    p.pause();
    p.resume();
    advance(t, 5000);
    p.stop();
  });
  assert.equal(written, "");
});

test("a terminal is not enough: CI, TERM=dumb and BUMPII_NO_PROGRESS each opt out", (t) => {
  // `enabled()` has four conditions and `asTty` clears three of them, so
  // without this test nothing exercises them at all — which is how a real
  // breakage got in: under GitHub Actions every drawing test was silently
  // handed SILENT, and six of them failed on a check that passed locally.
  //
  // The clock runs here for the reason the tty test above spells out: with no
  // frame ever firing, this stays green with all three checks deleted, because
  // the warm-up alone draws nothing.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const [key, value] of [
    ["CI", "true"],
    ["TERM", "dumb"],
    ["BUMPII_NO_PROGRESS", "1"],
  ] as const) {
    const written = asTty(120, () => {
      // asTty clears all of them; put back exactly the one under test, so each
      // opt-out is asserted on its own rather than as a group.
      process.env[key] = value;
      return capture(process.stderr, () => {
        const p = startProgress();
        p.phase("judge", { total: 12, done: 0 });
        advance(t, 5000);
        p.stop();
      });
    });
    assert.equal(written, "", `${key}=${value} must silence the line even on a terminal`);
  }
});

test("nothing is drawn during the warm-up, so a fast command stays clean", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const written = asTty(120, () =>
    capture(process.stderr, () => {
      const p = startProgress();
      // A command that finishes in 120ms: several frames' worth of ticks have
      // fired, but none of them may have drawn anything.
      advance(t, 120);
      p.stop();
    }),
  );
  assert.equal(written, "", "a spinner flashed on a command that was never slow");
});

test("past the warm-up it draws, and stopping erases what it drew", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const written = asTty(120, () =>
    capture(process.stderr, () => {
      const p = startProgress();
      p.phase("fetch", { total: 12, done: 3, tools: 12 });
      advance(t, 1000);
      p.stop();
    }),
  );
  assert.ok(written.includes(HIDE_CURSOR), "the cursor was never hidden");
  assert.match(written, /3\/12/, "the real count never made it onto the line");
  // Erase, then give the cursor back, and nothing after that: a frame written
  // after the erase is the one that survives into the user's scrollback.
  assert.ok(
    written.endsWith(ERASE_LINE + SHOW_CURSOR),
    "did not end by clearing its line and restoring the cursor",
  );
});

test("the line never exceeds the terminal width", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  // A line wider than the terminal wraps, and the erase sequence then clears
  // only its last row — leaving every frame behind as scrollback.
  const columns = 30;
  const written = asTty(columns, () =>
    capture(process.stderr, () => {
      const p = startProgress();
      p.phase("judge", { total: 12, done: 3, tools: 12, concurrency: 3 });
      advance(t, 1000);
      p.stop();
    }),
  );
  for (const frame of written.split("\r")) {
    const visible = visibleOnly(frame);
    assert.ok(
      visible.length < columns,
      `a frame was ${visible.length} columns wide in a ${columns}-column terminal: ${JSON.stringify(visible)}`,
    );
  }
});

test("output written through the progress object never lands on a spinner frame", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  asTty(120, () => {
    const p = startProgress();
    p.phase("update");
    advance(t, 1000);
    const onErr = capture(process.stderr, () => {
      p.out("the report\n");
    });
    // The erase has to come first; otherwise the report starts halfway along
    // whatever the last frame drew.
    assert.ok(onErr.startsWith(ERASE_LINE), "wrote to stdout without taking the line down first");
    p.stop();
  });
});

test("the bounce lands often enough to be a bounce", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const written = asTty(120, () =>
    capture(process.stderr, () => {
      const p = startProgress();
      p.phase("fetch");
      // One full cycle is roughly four seconds: jump, jump, scrape, roll,
      // shove. Five gives it room to come round again.
      advance(t, 5000);
      p.stop();
    }),
  );
  const impacts = written.match(/\*BUMP\*/g)?.length ?? 0;
  assert.ok(impacts >= 3, `only ${impacts} landings in five seconds — the ball is not bouncing`);
  // The version has to actually move, patch by patch...
  assert.match(written, /v0\.1\.1/);
  assert.match(written, /v0\.1\.3/);
  // ...and the shove out of the roll takes the minor, resetting the patch.
  assert.match(written, /v0\.2\.0/, "the big landing never bumped the minor");
});

test("every frame of the bounce is the same width", () => {
  // What holds the sentence still: the art is a fixed-width box the ball moves
  // inside. A new frame one column wider would push the words along with it,
  // and the drift would only show up on the landing frames.
  for (const f of FRAMES) {
    assert.equal(
      f.art.length,
      ART_WIDTH,
      `frame ${JSON.stringify(f.art)} is ${f.art.length} columns, not ${ART_WIDTH}`,
    );
  }
  // A damped bounce: several landings that scrape the patch, and exactly one
  // shove out of the roll that takes the minor.
  const patches = FRAMES.filter((f) => f.hit === "patch").length;
  const minors = FRAMES.filter((f) => f.hit === "minor").length;
  assert.ok(patches >= 2, `${patches} small landings — a damped bounce needs several`);
  assert.equal(minors, 1, "exactly one big shove ends the roll");
});

test("the cycle is paced, not ticked", (t) => {
  // The complaint that produced this shape: a constant tick is tiring to read.
  // What fixes it is a slow stretch long enough to read a sentence over, and
  // a fast stretch around the impact — so the frame timings must actually
  // differ, and the slowest must be several times the quickest.
  const times = FRAMES.map((f) => f.ms);
  const slowest = Math.max(...times);
  const quickest = Math.min(...times);
  assert.ok(slowest >= quickest * 4, `pacing is nearly flat: ${quickest}ms to ${slowest}ms`);

  // And a full cycle has to leave real reading time: at least a second where
  // no landing interrupts.
  let calm = 0;
  let longestCalm = 0;
  for (const f of FRAMES) {
    if (f.hit) calm = 0;
    else calm += f.ms;
    longestCalm = Math.max(longestCalm, calm);
  }
  assert.ok(longestCalm >= 1000, `only ${longestCalm}ms of unbroken calm in a cycle`);

  // Cheap guard against someone "just slowing it down" until it looks stuck.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const written = asTty(120, () =>
    capture(process.stderr, () => {
      const p = startProgress();
      p.phase("fetch");
      advance(t, 2000);
      p.stop();
    }),
  );
  const frames = written.split("\r").filter((f) => f.includes(ESC)).length;
  assert.ok(frames >= 6, `only ${frames} frames in two seconds — that reads as hung`);
});

test("the impact jolts the ball without dragging the sentence along", (t) => {
  // The first version shook the whole line, so the quip moved four columns
  // every landing — dramatic, and unreadable. The ball rattles; the words hold
  // their column.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const written = asTty(120, () =>
    capture(process.stderr, () => {
      const p = startProgress();
      p.phase("fetch");
      advance(t, 3000);
      p.stop();
    }),
  );

  const quip = "reading changelogs nobody reads";
  const columns = new Set<number>();
  const shakes = new Set<string>();
  for (const frame of written.split("\r")) {
    const visible = visibleOnly(frame);
    if (!visible.includes(quip)) continue;
    columns.add(visible.indexOf(quip));
    shakes.add(visible.slice(0, visible.indexOf(quip)).replace(/[^ ]/g, "").length.toString());
  }
  assert.ok(columns.size > 0, "no frame carried the sentence at all");
  assert.equal(columns.size, 1, `the sentence moved between columns ${[...columns].join(", ")}`);
  assert.ok(shakes.size > 1, "nothing ever jolted — the impact has no kick to it");
});

test("clamp counts what is printed, not what is escaped", () => {
  const yellow = `${ESC}[33m`;
  const reset = `${ESC}[0m`;
  const cut = clamp(`${yellow}${"x".repeat(50)}${reset}`, 20);
  assert.equal(visibleOnly(cut).length, 19, "cut to the wrong visible width");
  assert.ok(cut.startsWith(yellow), "dropped the colour it was told to start with");
  assert.ok(cut.endsWith(reset), "left the terminal in a colour it never reset");
});

test("clamp leaves a line that already fits alone", () => {
  const line = `${ESC}[2mshort${ESC}[0m`;
  assert.equal(clamp(line, 80), line);
});

test("clamp survives a terminal too narrow to be real", () => {
  // process.stderr.columns can be 0 in odd environments, and a negative slice
  // width would throw inside the draw loop.
  assert.ok(clamp("aaaaaaaaaaaaaaaaaaaa", 0).length > 0);
  assert.ok(clamp("aaaaaaaaaaaaaaaaaaaa", 1).length > 0);
});

test("a terminal reporting zero columns is treated as unknown, not as eight", (t) => {
  // Found by running the real CLI under `script`, where the pty has no size:
  // every frame came out cut to the bounce, with the sentence and the counts
  // sliced off. A width of 0 means "no idea", and guessing 80 is the only
  // reading that leaves a usable line.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const written = asTty(0, () =>
    capture(process.stderr, () => {
      const p = startProgress();
      p.phase("fetch", { total: 12, done: 3, tools: 12 });
      advance(t, 1000);
      p.stop();
    }),
  );
  assert.match(written, /reading changelogs nobody reads/, "the quip was cut off by a bogus width");
  assert.match(written, /3\/12/, "the count was cut off by a bogus width");
});
