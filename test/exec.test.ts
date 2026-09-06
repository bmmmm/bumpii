// SPDX-License-Identifier: GPL-3.0-or-later
// The exec wrappers: `run`'s buffer ceiling and timeout wording, and `stream`.
//
// Node kills a child whose output exceeds maxBuffer, and the 1 MiB default is
// a size real commands outgrow with the machine: `brew info --json=v2
// --installed` measured 827 KB for 178 formulae, so a machine with ~215
// formulae would have had `scan --new` die with an error blaming brew for a
// limit set in this repo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { killChildren, run, stream } from "../src/exec.ts";

test("output over Node's 1 MiB default survives, so brew's JSON cannot kill the child", async () => {
  const { stdout } = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]);
  assert.equal(stdout.length, 2 * 1024 * 1024);
});

test("a timeout says so instead of arriving as an unexplained SIGTERM", async () => {
  // Bare `sleep`, not `sh -c sleep`: a non-interactive sh defers signals until
  // its foreground command finishes, which would turn 100 ms into 5 s.
  const started = Date.now();
  await assert.rejects(run("sleep", ["5"], { timeout: 100 }), (err: Error) => {
    assert.match(err.message, /timed out after 100 ms/);
    return true;
  });
  // The timeout ended it, not the sleep: the whole thing took well under 5 s.
  assert.ok(Date.now() - started < 4000, "the sleep ran to completion — the timeout never fired");
});

test("an ordinary non-zero exit is not called a timeout", async () => {
  await assert.rejects(run("/bin/sh", ["-c", "exit 3"], { timeout: 10_000 }), (err: Error) => {
    assert.doesNotMatch(err.message, /timed out/);
    return true;
  });
});

test("stream resolves on exit 0 and names the code or signal it failed with", async () => {
  assert.deepEqual(await stream("/bin/sh", ["-c", "exit 0"]), { code: 0, signal: null });
  await assert.rejects(stream("/bin/sh", ["-c", "exit 7"]), /exited 7/);
  // ENOENT arrives on `error`, never on `exit`: a listener on the wrong event
  // would leave this promise pending forever rather than rejecting.
  await assert.rejects(stream("/nonexistent/bumpii-test-binary", []), /ENOENT/);
});

test("a streamed child is killable, so Ctrl-C takes it along", async () => {
  // A stream() that forgot to join the shared set would sit out the full
  // sleep here and then resolve — five seconds, not a hang, but a green run
  // that proves the opposite of what the name says. The time bound is what
  // makes the assertion.
  const started = Date.now();
  const pending = stream("sleep", ["5"]);
  // Give spawn a tick to hand out the pid before the kill is sent.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(killChildren() >= 1, "nothing was tracked to kill");
  await assert.rejects(pending, /killed by SIGTERM/);
  assert.ok(Date.now() - started < 2000, "the child outlived the signal");
});

test("a streamed child honours a timeout when the caller sets one, and says so", async () => {
  // The streamed path is the default for every run that is not --json — a
  // cron line writing to a log included — so "no timeout because somebody is
  // watching" is the caller's call, per run, not this function's.
  const started = Date.now();
  await assert.rejects(stream("sleep", ["5"], { timeout: 100 }), /timed out after 100 ms: killed by SIGTERM/);
  assert.ok(Date.now() - started < 4000, "the sleep ran to completion — the timeout never fired");
  // And without one, a signal is reported as what it was.
  const pending = stream("sleep", ["5"]);
  await new Promise((r) => setTimeout(r, 50));
  killChildren();
  await assert.rejects(pending, /^Error: killed by SIGTERM$/);
});
