// SPDX-License-Identifier: GPL-3.0-or-later
// The launcher derives the repo root from $0. The documented install is a
// symlink in ~/.local/bin, which made the first version resolve the root to
// ~/.local and die with "Cannot find module ~/.local/src/cli.ts" — a break
// that only ever appears through the installed path, never in a repo checkout.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "bin", "bumpii");

test("launcher works when invoked directly", async () => {
  const { stdout } = await run(launcher, ["--help"]);
  assert.match(stdout, /^bumpii —/);
});

test("launcher works when invoked through a symlink elsewhere", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bumpii-launcher-"));
  try {
    const link = join(dir, "bumpii");
    await symlink(launcher, link);
    const { stdout } = await run(link, ["--help"]);
    assert.match(stdout, /^bumpii —/, "symlinked launcher must resolve its own repo root");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
