// SPDX-License-Identifier: GPL-3.0-or-later
// The exec wrapper's buffer ceiling. Node kills a child whose output exceeds
// maxBuffer, and the 1 MiB default is a size real commands outgrow with the
// machine: `brew info --json=v2 --installed` measured 827 KB for 178 formulae,
// so a machine with ~215 formulae would have had `scan --new` die with an
// error blaming brew for a limit set in this repo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/exec.ts";

test("output over Node's 1 MiB default survives, so brew's JSON cannot kill the child", async () => {
  const { stdout } = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"]);
  assert.equal(stdout.length, 2 * 1024 * 1024);
});
