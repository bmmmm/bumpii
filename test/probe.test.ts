// SPDX-License-Identifier: GPL-3.0-or-later
// Version probing against real binaries, because every interesting case here
// is about what a CLI actually does: print to stderr, exit non-zero and still
// be right, or lead with the number and leave nothing to anchor a regex on.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { confirmProbe } from "../src/discover.ts";
import type { ToolConfig } from "../src/types.ts";
import { installedVersion } from "../src/version.ts";

let dir: string | null = null;

/** Write an executable shell script and hand back its path. */
async function fixture(name: string, body: string): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), "bumpii-probe-"));
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

test.after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const tool = (cmd: string[], match: string): ToolConfig => ({
  name: "fixture",
  source: "github:o/r",
  version: { cmd, match },
  update: "true",
});

test("installedVersion reads a version a CLI prints to stderr", async () => {
  const bin = await fixture("to-stderr", 'echo "fixture version 1.2.3" >&2');
  const v = await installedVersion(tool([bin, "--version"], "fixture version ([0-9][0-9.]*)"));
  assert.equal(v, "1.2.3");
});

test("installedVersion trusts output from a non-zero exit", async () => {
  // Some CLIs treat `--version` as an unrecognised command, print the version
  // in the usage text, and exit 1. That output is still the answer.
  const bin = await fixture("angry", 'echo "fixture version 2.0.1"; exit 1');
  const v = await installedVersion(tool([bin, "--version"], "fixture version ([0-9][0-9.]*)"));
  assert.equal(v, "2.0.1");
});

test("installedVersion reports a tool that is not installed as null, not an error", async () => {
  const v = await installedVersion(tool([join(tmpdir(), "bumpii-no-such-binary"), "--version"], "x"));
  assert.equal(v, null, "a tracked tool you have not installed yet is a normal state");
});

test("installedVersion separates a pattern that captures nothing from one that misses", async () => {
  const bin = await fixture("plain", 'echo "fixture version 3.1.0"');
  await assert.rejects(
    installedVersion(tool([bin, "--version"], "fixture version [0-9][0-9.]*")),
    /captured nothing — put the version number in parentheses/,
  );
  await assert.rejects(
    installedVersion(tool([bin, "--version"], "nothing like this ([0-9]+)")),
    /did not match output/,
  );
});

test("installedVersion fails loudly when the probe produced nothing at all", async () => {
  const bin = await fixture("silent", "exit 3");
  await assert.rejects(installedVersion(tool([bin], "([0-9]+)")), /version probe failed/);
});

test("confirmProbe anchors on the text in front of the version", async () => {
  const bin = await fixture("anchored", 'echo "anchored version 4.5.6"');
  const probe = await confirmProbe(bin, "4.5.6");
  assert.ok(probe, "a binary that reports the known version must be accepted");
  assert.match(probe.match, /anchored version/, "the surrounding text is what keeps it specific");
  assert.equal(await installedVersion(tool(probe.cmd, probe.match)), "4.5.6");
});

test("confirmProbe anchors to the line when the version leads it", async () => {
  // fzf prints "0.74.1 (Homebrew)". With nothing in front of the number the
  // generated pattern used to be a bare number match — and installedVersion
  // runs it over the whole output, so it would take the first digits anywhere,
  // here the year on the line above.
  const bin = await fixture("leading", 'echo "built 2019 by someone"; echo "7.8.9 (Homebrew)"');
  const probe = await confirmProbe(bin, "7.8.9");
  assert.ok(probe);
  assert.equal(
    await installedVersion(tool(probe.cmd, probe.match)),
    "7.8.9",
    "an unanchored pattern would have returned 2019",
  );
});

test("confirmProbe falls through the probe forms until one reports the version", async () => {
  // forgejo-cli is the live case: `fj --version` errors, `fj version` works.
  const bin = await fixture(
    "picky",
    'if [ "$1" = "version" ]; then echo "picky 1.0.0"; else echo "unexpected argument" >&2; exit 2; fi',
  );
  const probe = await confirmProbe(bin, "1.0.0");
  assert.ok(probe);
  assert.deepEqual(probe.cmd, [bin, "version"]);
});

test("confirmProbe returns null rather than a pattern that never resolves", async () => {
  // A generated entry whose regex matches nothing would make the tool look
  // permanently "not installed" — worse than refusing to write one.
  const bin = await fixture("mismatched", 'echo "mismatched version 9.9.9"');
  assert.equal(await confirmProbe(bin, "1.2.3"), null);
});
