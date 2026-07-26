// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { bare, parseSource } from "../src/sources.ts";
import { compareVersions, releasesBehind } from "../src/version.ts";
import { parseArgs } from "../src/cli.ts";
import type { Release } from "../src/types.ts";

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
