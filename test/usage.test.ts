// SPDX-License-Identifier: GPL-3.0-or-later
// The usage verdict is the one claim this tool makes that nothing else does,
// so the ways it can be quietly wrong are worth pinning down: a needle too
// broad to mean anything, a path that was never searched, and the attribution
// of a match now that all needles share a single grep.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commandsFromNotes,
  findUsage,
  findUsageAcross,
  mentioned,
  resolveUsagePaths,
  toNeedles,
} from "../src/usage.ts";

// Verbatim from the gh 2.97.0 release notes (cli/cli), abridged. Kept real
// because the whole question here is whether the extractor survives prose
// written by people: the token-format examples below (`github_pat_*`, `ghs_*`)
// sit in the same sentence as a genuine command, and a substring match would
// take all three.
const GH_NOTES = `## Security

Several commands (including \`gh gist view\`, \`gh api\`, \`gh pr diff\`, and
\`gh release download --output -\`) printed externally controlled content
without neutralizing terminal escape sequences.

\`gh auth status\` (without \`--show-token\`) could print a portion of the
authentication token in plaintext for token types whose format contains an
underscore after the prefix, such as \`github_pat_*\`, \`ghs_*\`, and \`ghu_*\`.

\`gh attestation verify\` built the certificate matcher from \`--signer-repo\`
without escaping regex metacharacters.`;

test("commands are read out of real release notes without a model", () => {
  const got = commandsFromNotes("gh", GH_NOTES);
  // The surfaces a reader would act on.
  assert.ok(got.includes("gh auth status"), "the command behind the token leak");
  assert.ok(got.includes("gh attestation verify"));
  assert.ok(got.includes("gh gist view"));
  assert.ok(got.includes("gh release download --output -"));
});

test("a span is only kept when it names the tool as a word", () => {
  // The case the word boundary actually decides — and it has to be one that
  // clears toNeedles, or the filter under test never runs: "team sync --all"
  // is specific enough to be kept, and contains "tea" only as a substring.
  // A `tea` user's notes talking about teams would otherwise be grepped for a
  // command that does not exist.
  assert.deepEqual(commandsFromNotes("tea", "Use `team sync --all` to invite everyone."), []);
  assert.deepEqual(commandsFromNotes("tea", "Use `tea pulls list --state open`."), [
    "tea pulls list --state open",
  ]);
});

test("note extraction refuses groups and bare flags, which match half a machine", () => {
  const got = commandsFromNotes("gh", GH_NOTES);
  // Two tokens, no flag: "gh api" names a group, not a surface.
  assert.ok(!got.includes("gh api"), "a two-token group is too broad to mean anything");
  // A flag on its own is not attributable to this tool at all.
  assert.ok(!got.includes("--show-token"));
  // Token formats sitting in the same sentence as real commands.
  for (const junk of ["github_pat_*", "ghs_*", "ghu_*"]) {
    assert.ok(!got.includes(junk), `${junk} is not a command`);
  }
});

test("punctuation inside the code span is stripped from the command", () => {
  // Notes really are written as "`gh pr view --json.`" with the full stop
  // inside the span. Grepping that verbatim finds nothing, which is
  // indistinguishable from a checked "affects you: none".
  assert.deepEqual(commandsFromNotes("gh", "Fixed `gh pr view --json.`"), ["gh pr view --json"]);
  assert.deepEqual(commandsFromNotes("gh", "Fixed `gh pr view --json`, see below."), ["gh pr view --json"]);
});

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

test("findUsageAcross keeps each tool's hits to its own needles", async () => {
  // One grep now serves every tool in a run, so the split back into per-tool
  // hits is done in JS and is exactly where a batched search can go wrong:
  // silently handing tool A the matches of tool B would read as "affects you"
  // about a file that names something else entirely.
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await mkdir(join(dir, "scripts"));
    await writeFile(join(dir, "scripts", "deploy.sh"), "gh pr view --json number\n");
    await writeFile(join(dir, "scripts", "sync.sh"), "tea pulls list --state open\n");

    const [gh, tea, jq] = await findUsageAcross(
      [dir],
      [["gh pr view --json"], ["tea pulls list --state"], ["jq --slurp --raw"]],
    );

    assert.deepEqual(
      gh?.map((h) => h.command),
      ["gh pr view --json"],
    );
    assert.match(gh?.[0]?.file ?? "", /deploy\.sh$/);
    assert.deepEqual(
      tea?.map((h) => h.command),
      ["tea pulls list --state"],
    );
    assert.match(tea?.[0]?.file ?? "", /sync\.sh$/);
    assert.deepEqual(jq, [], "a tool whose commands appear nowhere gets an empty list, not someone else's");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findUsageAcross gives a shared needle to every tool that asked for it", async () => {
  // Separate greps would have handed the same line to both tools, and batching
  // must not quietly make it exclusive to whichever group is listed first.
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await writeFile(join(dir, "release.sh"), "gh auth status --hostname github.com\n");

    const groups = await findUsageAcross(
      [dir],
      [["gh auth status --hostname"], ["gh auth status --hostname"]],
    );

    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.length, 1);
    assert.deepEqual(groups[0], groups[1], "both tools asked, both are answered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findUsageAcross returns one list per group even with nothing to search", async () => {
  // The positional contract is what the callers index into; a short array here
  // would silently drop the last tool's hits rather than fail.
  assert.deepEqual(await findUsageAcross([], [["gh pr view --json"], ["tea pulls list"]]), [[], []]);
  assert.deepEqual(await findUsageAcross(["/nonexistent"], []), []);
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

test("mentioned reports which names appear, and says nothing about the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bumpii-usage-"));
  try {
    await writeFile(join(dir, "deploy.sh"), "#!/bin/sh\nrestic backup /data | jq .\n");
    const found = await mentioned([dir], ["restic", "jq", "mpv", "yt-dlp"]);
    assert.deepEqual([...found].sort(), ["jq", "restic"]);
    assert.equal(found.has("mpv"), false, "the absence is the whole point of the command");
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
    assert.equal(found.has("jq"), true);
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
    assert.equal((await mentioned([dir], ["restic", "mpv"])).size, 0);
    assert.equal((await mentioned([], ["restic"])).size, 0, "nowhere to search is not a match either");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
