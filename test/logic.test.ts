// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { formulaOf, parseArgs } from "../src/cli.ts";
import { bare, parseSource } from "../src/sources.ts";
import type { Release } from "../src/types.ts";
import {
  compareVersions,
  isComparable,
  isTruncated,
  latestComparable,
  releasesBehind,
} from "../src/version.ts";

const rel = (version: string): Release => ({
  tag: `v${version}`,
  version,
  publishedAt: null,
  notes: "",
  url: "",
});

test("bare strips a leading v so tag forms compare equal", () => {
  assert.equal(bare("v2.96.0"), "2.96.0");
  assert.equal(bare("2.96.0"), "2.96.0");
});

test("bare strips a name prefix, not just a v", () => {
  // jq tags releases `jq-1.8.2`. Leaving the name in sent every comparison
  // into the non-numeric branch, which reported "up to date" forever — a
  // silent wrong answer, the one failure mode an update checker must not have.
  assert.equal(bare("jq-1.8.2"), "1.8.2");
  assert.equal(bare("release-3.0"), "3.0");
});

test("a newer name-prefixed tag is detected as behind", () => {
  const mk = (tag: string) => ({ tag, version: bare(tag), publishedAt: null, notes: "", url: "" });
  const behind = releasesBehind([mk("jq-1.9.0"), mk("jq-1.8.2")], "1.8.2");
  assert.deepEqual(
    behind.map((r) => r.version),
    ["1.9.0"],
    "a new jq release must show up as pending",
  );
});

test("parseSource understands the three source forms", () => {
  assert.deepEqual(parseSource("github:cli/cli"), {
    kind: "github",
    api: "https://api.github.com",
    repo: "cli/cli",
  });
  assert.deepEqual(parseSource("codeberg:forgejo-contrib/forgejo-cli"), {
    kind: "forgejo",
    api: "https://codeberg.org/api/v1",
    repo: "forgejo-contrib/forgejo-cli",
  });
  assert.deepEqual(parseSource("https://git.example.com/team/app.git"), {
    kind: "forgejo",
    api: "https://git.example.com/api/v1",
    repo: "team/app",
  });
});

test("parseSource rejects an unusable source instead of guessing", () => {
  assert.throws(() => parseSource("cli/cli"), /unrecognised source/);
  assert.throws(() => parseSource("https://example.com/"), /no owner\/repo/);
});

test("compareVersions orders by numeric segment, not lexically", () => {
  // The lexical trap: "10" < "9" as strings.
  assert.ok(compareVersions("2.10.0", "2.9.0") > 0);
  assert.ok(compareVersions("0.6.0", "0.6.0") === 0);
  assert.ok(compareVersions("2.96.0", "2.96.1") < 0);
  // Missing segments count as zero, so 1.2 and 1.2.0 are the same version.
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
});

test("releasesBehind returns only newer releases, oldest first", () => {
  const all = [rel("2.96.0"), rel("2.95.0"), rel("2.94.0"), rel("2.93.0")]; // newest first
  const behind = releasesBehind(all, "2.94.0");
  assert.deepEqual(
    behind.map((r) => r.version),
    ["2.95.0", "2.96.0"],
  );
});

test("releasesBehind on an up-to-date tool yields nothing", () => {
  assert.deepEqual(releasesBehind([rel("1.0.0")], "1.0.0"), []);
});

test("releasesBehind with no installed version takes only the newest", () => {
  // A tool you track but have not installed should not dump every historical
  // release's notes at you.
  const behind = releasesBehind([rel("3.0.0"), rel("2.0.0"), rel("1.0.0")], null);
  assert.deepEqual(
    behind.map((r) => r.version),
    ["3.0.0"],
  );
});

test("parseArgs defaults to a read-only digest", () => {
  const a = parseArgs([]);
  assert.equal(a.cmd, "digest");
  assert.equal(a.yes, false, "updating must never be the default");
});

test("parseArgs reads the flags that change behaviour", () => {
  const a = parseArgs(["--only", "gh,fj", "--model", "haiku", "--yes", "--json"]);
  assert.deepEqual(a.only, ["gh", "fj"]);
  assert.equal(a.model, "haiku");
  assert.equal(a.yes, true);
  assert.equal(a.json, true);
});

test("parseArgs rejects an unknown option rather than ignoring it", () => {
  assert.throws(() => parseArgs(["--upgrade-everything"]), /unknown option/);
});

test("parseArgs refuses to swallow the next flag as an option value", () => {
  // `--model --json` used to set the model to "--json" and silently drop the
  // flag that was meant to change the output.
  assert.throws(() => parseArgs(["--model", "--json"]), /--model needs a value/);
  assert.throws(() => parseArgs(["--only"]), /--only needs a value/);
});

test("isComparable rejects a tag that cannot be ordered", () => {
  assert.equal(isComparable(rel("2.96.0")), true);
  assert.equal(isComparable({ ...rel("x"), version: "nightly" }), false);
  assert.equal(isComparable({ ...rel("x"), version: "" }), false);
});

test("formulaOf skips options instead of reading one as the formula", () => {
  // `scan` matches tracked tools by the formula their update command upgrades.
  // Taking "--fetch-HEAD" as the formula meant an already-tracked tool kept
  // being offered as untracked.
  assert.deepEqual(formulaOf("brew upgrade gh"), ["gh"]);
  assert.deepEqual(formulaOf("brew upgrade --fetch-HEAD gh"), ["gh"]);
  assert.deepEqual(formulaOf("brew install --cask foo"), ["foo"]);
  assert.deepEqual(formulaOf("brew upgrade jundot/omlx/omlx"), ["jundot/omlx/omlx"]);
});

test("formulaOf yields nothing for an update command that is not brew", () => {
  assert.deepEqual(formulaOf("cargo install ripgrep"), []);
  assert.deepEqual(formulaOf("brew upgrade"), [], "a bare upgrade names no formula");
});

test("isTruncated fires only when the page ran out before your version did", () => {
  // The 30-release page is a floor, not a count: yabai has over a hundred, so
  // a stale install reads as "30 releases behind" when it is far more.
  const page = [rel("3.0"), rel("2.0"), rel("1.0")];
  assert.equal(
    isTruncated(page, releasesBehind(page, "0.9"), true),
    true,
    "every release on a full page is newer — the boundary ended the list, not the version",
  );
  assert.equal(
    isTruncated(page, releasesBehind(page, "1.0"), true),
    false,
    "the oldest release on the page is one you already have, so the count is exact",
  );
  assert.equal(isTruncated(page, releasesBehind(page, "0.9"), false), false, "a short page is complete");
  assert.equal(isTruncated(page, [], true), false, "nothing pending is never truncated");
});

test("latest skips a rolling pointer release at the head of the list", () => {
  // Verified against the live API: neovim publishes a `stable` release next to
  // v0.12.4, both with "prerelease": false, so nothing filters it out — and
  // whichever was republished last comes first. Taking releases[0] gave an
  // empty version, rendering as "0.12.2 → " with nothing after the arrow.
  const stable = { ...rel("x"), tag: "stable", version: "" };
  assert.equal(latestComparable([stable, rel("0.12.4"), rel("0.12.3")]), "0.12.4");
  assert.equal(latestComparable([rel("0.12.4"), stable]), "0.12.4");
  assert.equal(latestComparable([stable]), null, "nothing comparable is null, not an empty string");
  assert.equal(latestComparable([]), null);
});

test("an unorderable tag never counts as a release you are behind", () => {
  // compareVersions sends "nightly" into its NaN branch, which answers "not
  // newer" — indistinguishable from being current. Filtering first is what
  // lets the report say "unknown" instead of a green "up to date".
  const all = [{ ...rel("x"), version: "nightly" }, rel("1.0.0")];
  assert.deepEqual(
    releasesBehind(all, "1.0.0").map((r) => r.version),
    [],
  );
  assert.deepEqual(
    releasesBehind([{ ...rel("x"), version: "continuous" }], null).map((r) => r.version),
    [],
    "with nothing installed, an unorderable newest release is still nothing to show",
  );
});
