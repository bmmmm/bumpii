// SPDX-License-Identifier: GPL-3.0-or-later
// The usage verdict is the one claim this tool makes that nothing else does,
// so the ways it can be quietly wrong are worth pinning down: a needle too
// broad to mean anything, a path that was never searched, and the attribution
// of a match now that all needles share a single grep.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mentioned, referenceCounts, resolveUsagePaths } from "../src/usage.ts";

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

test("the absence claims of scan --unref and overview carry the same flag", async () => {
  // mentioned() and referenceCounts() each answer a question about absence —
  // "no file of yours names this" and "zero references" — from the same grep
  // exit code, so both silences fail the same way.
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await writeFile(join(dir, "deploy.sh"), "restic backup\n");
    const gone = join(dir, "was-here-a-moment-ago");

    const named = await mentioned([gone, dir], ["restic", "jq"]);
    assert.ok(named.incomplete, "an unreferenced verdict from a failed grep is not a verdict");
    assert.ok(named.names.has("restic"), "what it did read still counts");

    const refs = await referenceCounts([gone, dir], ["restic", "jq"]);
    assert.ok(refs.incomplete);
    assert.equal(refs.counts.get("restic"), 1);
    assert.equal(refs.counts.get("jq"), 0, "a zero from an unfinished walk is still reported as a zero");

    const clean = await mentioned([dir], ["restic"]);
    assert.equal(clean.incomplete, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mentioned reports which names appear, and says nothing about the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await writeFile(join(dir, "deploy.sh"), "#!/bin/sh\nrestic backup /data | jq .\n");
    const found = await mentioned([dir], ["restic", "jq", "mpv", "yt-dlp"]);
    assert.deepEqual([...found.names].sort(), ["jq", "restic"]);
    assert.equal(found.names.has("mpv"), false, "the absence is the whole point of the command");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mentioned matches a substring, which is the safe direction to be wrong in", async () => {
  // "jq" inside "jquery" counts as mentioned. That over-reports a name as used
  // — costing a candidate — where word-boundary matching would under-report it
  // and produce the confident wrong answer the command exists to avoid.
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await writeFile(join(dir, "page.html"), "<script src=jquery.min.js></script>\n");
    const found = await mentioned([dir], ["jq"]);
    assert.equal(found.names.has("jq"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mentioned returns an empty set rather than every name when nothing matches", async () => {
  // grep exits 1 on no matches. Reading that as a failure and falling back to
  // "all names found" would make the command answer "everything is used".
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await writeFile(join(dir, "a.sh"), "echo hello\n");
    assert.equal((await mentioned([dir], ["restic", "mpv"])).names.size, 0);
    assert.equal((await mentioned([], ["restic"])).names.size, 0, "nowhere to search is not a match either");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
