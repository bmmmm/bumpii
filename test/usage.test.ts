// SPDX-License-Identifier: GPL-3.0-or-later
// The usage verdict is the one claim this tool makes that nothing else does,
// so the ways it can be quietly wrong are worth pinning down: a needle too
// broad to mean anything, a path that was never searched, and the attribution
// of a match now that all needles share a single grep.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findUsage, resolveUsagePaths, toNeedles } from "../src/usage.ts";

test("toNeedles drops commands too broad to mean anything", () => {
  // "gh pr" appears in half of anyone's scripts; reporting "affects you" on it
  // trains you to ignore the line that matters.
  assert.deepEqual(toNeedles(["gh", "gh pr", "git"]), []);
});

test("toNeedles keeps three-token commands and anything carrying a flag", () => {
  assert.deepEqual(toNeedles(["gh pr view", "gh pr --json"]), ["gh pr view", "gh pr --json"]);
});

test("toNeedles does not mistake a hyphenated name for a flag", () => {
  // The bar is specificity: "gh auth-status" is two tokens like "gh pr", and a
  // hyphen inside a word says nothing about how specific the command is.
  assert.deepEqual(toNeedles(["gh auth-status"]), []);
});

test("toNeedles normalises whitespace and deduplicates", () => {
  assert.deepEqual(toNeedles(["gh  pr   view", "gh pr view "]), ["gh pr view"]);
});

test("resolveUsagePaths separates searchable paths from missing ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    const { roots, missing } = await resolveUsagePaths([dir, join(dir, "nope")]);
    assert.deepEqual(roots, [dir]);
    assert.deepEqual(missing, [join(dir, "nope")], "a path that does not exist must be named");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findUsage attributes each match to the needle that produced it", async () => {
  // All needles now share one grep, so the mapping from output line back to
  // needle happens in JS — including a line that contains two of them.
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await mkdir(join(dir, "scripts"));
    await writeFile(join(dir, "scripts", "deploy.sh"), "#!/bin/sh\ngh pr view --json number\n");
    await writeFile(join(dir, "scripts", "other.sh"), "echo nothing to see\n");

    const hits = await findUsage([dir], ["gh pr view", "gh pr view --json", "gh release verify"]);
    const byCommand = new Map(hits.map((h) => [h.command, h]));

    assert.equal(hits.length, 2, "one line containing two needles is two hits");
    assert.equal(byCommand.get("gh pr view")?.line, 2);
    assert.match(byCommand.get("gh pr view --json")?.file ?? "", /deploy\.sh$/);
    assert.equal(
      byCommand.has("gh release verify"),
      false,
      "a command that appears nowhere is the useful answer, not a hit",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findUsage treats a needle as a fixed string, not a pattern", async () => {
  // Release notes contain things like `foo[bar]` and `gh pr view --json`, which
  // as a regex would either break or over-match.
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await writeFile(join(dir, "a.sh"), "run foo[bar] --now\nrun fooX --now\n");
    const hits = await findUsage([dir], ["foo[bar] --now"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.line, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findUsage returns nothing when there is nowhere to search", async () => {
  assert.deepEqual(await findUsage([], ["gh pr view"]), []);
});
