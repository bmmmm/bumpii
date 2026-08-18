// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  containerOf,
  formulaOf,
  isManualUpdate,
  isPlaceholderUpdate,
  parseArgs,
  parseWindow,
} from "../src/cli.ts";
import { bare, parseSource } from "../src/sources.ts";
import type { Release, ToolConfig } from "../src/types.ts";
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

test("a manual update line is a complete entry, a comment is an unfinished one", () => {
  // Both are skipped by --yes, but only the placeholder is a gap: some tools
  // (Ghostty's Sparkle updater) simply have no CLI trigger, and an entry
  // saying so must not read as needing work forever.
  assert.equal(isManualUpdate("manual: open the app's updater"), true);
  assert.equal(isManualUpdate("Manual"), true);
  assert.equal(isManualUpdate("# complete this: pull and restart"), false);
  assert.equal(
    isManualUpdate("manually curated script.sh"),
    false,
    "a word starting with manual is not the marker",
  );
  assert.equal(isManualUpdate("brew upgrade gh"), false);
  assert.equal(isPlaceholderUpdate("manual: open the app's updater"), false, "manual is not a placeholder");
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

test("a letter suffix on a segment is newer, not equal", () => {
  // tmux tags 3.5a after 3.5, openssl went 1.1.1t → 1.1.1w. Reading the
  // segment with parseInt drops the letter, which made both pairs compare
  // equal — and equal renders as a green "up to date" over a pending release.
  assert.ok(compareVersions("3.5a", "3.5") > 0, "tmux 3.5a is newer than 3.5");
  assert.ok(compareVersions("3.5", "3.5a") < 0);
  assert.ok(compareVersions("1.1.1w", "1.1.1t") > 0, "openssl w is newer than t");
  assert.ok(compareVersions("1.1.1t", "1.1.1w") < 0);
  assert.ok(compareVersions("3.5b", "3.5a") > 0);
  assert.ok(compareVersions("1.1.1za", "1.1.1z") > 0, "a longer suffix continues the run");
});

test("a prerelease tail still sorts before the release it leads to", () => {
  // The letter-suffix fix must not swallow this: "3.5a" is newer than "3.5",
  // but "1.0.0-rc1" is OLDER than "1.0.0". Splitting on "." and "-" alike is
  // what erased that difference, so the two cases are asserted together.
  assert.ok(compareVersions("1.0.0", "1.0.0-rc1") > 0);
  assert.ok(compareVersions("1.0.0-rc1", "1.0.0") < 0);
  assert.ok(compareVersions("1.0.0-rc2", "1.0.0-rc1") > 0);
  assert.ok(compareVersions("1.0.0-rc1", "1.0.0-beta") > 0);
  // Build metadata carries no precedence, so it cannot make a version newer.
  assert.equal(compareVersions("1.0.0+build", "1.0.0"), 0);
});

test("compareVersions calls two versions equal only when they are", () => {
  // The property the 3.5a bug violated, stated as a property rather than as
  // another list of pairs: answering 0 for versions that are not the same
  // version is exactly how a pending release becomes "up to date". Only the
  // documented equivalences — a missing segment is zero, build metadata is
  // ignored — may compare equal while spelled differently.
  const same = new Set(["1.2|1.2.0", "1.2.0|1.2", "1.0.0+build|1.0.0", "1.0.0|1.0.0+build"]);
  const corpus = [
    "1.0.0",
    "1.2",
    "1.2.0",
    "1.0.0+build",
    "3.5",
    "3.5a",
    "3.5b",
    "1.1.1t",
    "1.1.1w",
    "1.1.1z",
    "1.1.1za",
    "1.0.0-rc1",
    "1.0.0-rc2",
    "1.0.0-beta",
    "2.9.0",
    "2.10.0",
    "20231231",
    "20240101",
  ];
  for (const a of corpus) {
    for (const b of corpus) {
      if (a === b || same.has(`${a}|${b}`)) continue;
      assert.notEqual(compareVersions(a, b), 0, `${a} and ${b} are not the same version`);
    }
  }
  // A comparator that is not antisymmetric orders a list differently depending
  // on where each release happened to sit in it.
  for (const a of corpus) {
    for (const b of corpus) {
      // Summed rather than negated: Math.sign(0) is 0 and -Math.sign(0) is -0,
      // which strict equality tells apart for no reason that matters here.
      assert.equal(
        Math.sign(compareVersions(a, b)) + Math.sign(compareVersions(b, a)),
        0,
        `${a} vs ${b} must reverse cleanly`,
      );
    }
  }
});

test("latestComparable takes the highest version, not the first one listed", () => {
  // A forge that republishes an old tag moves it to the head of the list. The
  // report prints this as "→ latest", so reading position instead of order
  // points the arrow at a version you are already past.
  assert.equal(latestComparable([rel("1.0.0"), rel("2.0.0"), rel("1.5.0")]), "2.0.0");
  assert.equal(latestComparable([rel("3.5"), rel("3.5a")]), "3.5a");
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

test("the bare name is help, so the expensive command cannot be run by accident", () => {
  // The digest is a forge round-trip per tool and a model that can sit on one
  // release for minutes. It has to be asked for.
  assert.equal(parseArgs([]).cmd, "help");
});

test("parseArgs defaults to a read-only digest once anything is asked of it", () => {
  // Any argument at all means somebody meant it — which is what keeps the
  // `bumpii --only <image>` in images-digest.sh and a `bumpii --json` cron
  // line working exactly as they did.
  for (const argv of [["digest"], ["--json"], ["--only", "gh"]]) {
    const a = parseArgs(argv);
    assert.equal(a.cmd, "digest", `${argv.join(" ")} should still digest`);
    assert.equal(a.yes, false, "updating must never be the default");
    assert.equal(a.brewUpgrade, false, "a blanket brew upgrade must never be the default either");
  }
});

test("parseArgs keeps --brew-upgrade apart from --yes", () => {
  // Two different kinds of "yes" — one judged and per-tool, one not — so
  // reading one must never imply the other.
  assert.equal(parseArgs(["--brew-upgrade"]).brewUpgrade, true);
  assert.equal(parseArgs(["--brew-upgrade"]).yes, false);
  assert.equal(parseArgs(["--yes"]).brewUpgrade, false);
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

test("parseArgs refuses an empty option value instead of widening the run", () => {
  // `--only ""` parsed to the same empty list as no --only at all, so a shell
  // variable that expanded to nothing silently ran every tracked tool. With
  // --yes that is the difference between upgrading nothing and upgrading
  // everything, and nothing in the output says which question was asked.
  //
  // Measured: two tools configured, `--only ""` digested both.
  assert.throws(() => parseArgs(["--only", ""]), /--only needs a value/);
  assert.throws(() => parseArgs(["--only", "   "]), /--only needs a value/);
  assert.throws(() => parseArgs(["--only", ","]), /--only needs a value/);
  // Same helper, so the other three options that take one are covered too.
  assert.throws(() => parseArgs(["--model", ""]), /--model needs a value/);
  assert.throws(() => parseArgs(["add", "--source", ""]), /--source needs a value/);
  // And a real value still parses, including a list with a stray comma.
  assert.deepEqual(parseArgs(["--only", "gh,uv"]).only, ["gh", "uv"]);
  assert.deepEqual(parseArgs(["--only", "gh, uv,"]).only, ["gh", "uv"]);
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

test("parseArgs routes the entry-management subcommands", () => {
  assert.equal(parseArgs(["list"]).cmd, "list");
  assert.equal(parseArgs(["rm", "gh"]).cmd, "rm");
  assert.deepEqual(parseArgs(["rm", "gh", "jq"]).rest, ["gh", "jq"]);

  const set = parseArgs(["set", "pg", "update", "docker", "pull", "x"]);
  assert.equal(set.cmd, "set");
  assert.deepEqual(set.rest, ["pg", "update", "docker", "pull", "x"], "a multi-word value stays intact");
});

test("parseArgs reads --source as a value, not a flag", () => {
  const a = parseArgs(["add", "--image", "pg", "--source", "github:postgres/postgres"]);
  assert.equal(a.image, true);
  assert.equal(a.source, "github:postgres/postgres");
  assert.deepEqual(a.rest, ["pg"]);
  assert.throws(() => parseArgs(["add", "--image", "pg", "--source"]), /--source needs a value/);
});

test("an unfinished update line is recognised as a placeholder", () => {
  // `sh -c` runs a comment and exits 0, so an entry left unfinished by
  // `add --image` would otherwise report an update that never happened.
  assert.equal(isPlaceholderUpdate("# complete this: pull app and restart it"), true);
  assert.equal(isPlaceholderUpdate("   # still a comment"), true);
  assert.equal(isPlaceholderUpdate("brew upgrade gh"), false);
  assert.equal(isPlaceholderUpdate("podman pull app && systemctl restart app"), false);
});

test("formulaOf yields nothing for an update command that is not brew", () => {
  assert.deepEqual(formulaOf("cargo install ripgrep"), []);
  assert.deepEqual(formulaOf("brew upgrade"), [], "a bare upgrade names no formula");
});

/** An entry whose only interesting part here is the version probe. */
const probing = (cmd: string[]): ToolConfig => ({
  name: "entry",
  source: "",
  version: { cmd, match: "v?([0-9][0-9.]*)" },
  update: "true",
});

test("containerOf reads the container off a runtime inspect probe", () => {
  // `scan --image` matches on this as well as the entry name: an entry renamed
  // by hand still inspects the real container, and matching only on the key
  // would keep offering that container as untracked.
  const tmpl = '{{index .Config.Labels "org.opencontainers.image.version"}}';
  assert.deepEqual(containerOf(probing(["podman", "inspect", "--format", tmpl, "grafana"])), ["grafana"]);
  assert.deepEqual(containerOf(probing(["docker", "inspect", "--format", "{{.Config.Image}}", "pg"])), [
    "pg",
  ]);
});

test("parseWindow reads days and weeks, and defaults the unit to days", () => {
  assert.equal(parseWindow("14d"), 14);
  assert.equal(parseWindow("3w"), 21);
  assert.equal(parseWindow("30"), 30, "a bare number is days");
  assert.equal(parseWindow(" 7d "), 7);
});

test("parseWindow refuses a window that would silently mean something else", () => {
  // "0d" is a window nothing can fall into, and a unit that is not understood
  // must not quietly be read as days: `--since 6h` meaning six days would be a
  // wrong answer with no sign that anything went wrong.
  assert.throws(() => parseWindow("0"), /positive window/);
  assert.throws(() => parseWindow("6h"), /positive window/);
  assert.throws(() => parseWindow("-3d"), /positive window/);
  assert.throws(() => parseWindow("last tuesday"), /positive window/);
});

test("parseArgs takes the scan modes and their window", () => {
  const a = parseArgs(["scan", "--new", "--since", "3w", "--deps"]);
  assert.equal(a.cmd, "scan");
  assert.equal(a.onlyNew, true);
  assert.equal(a.sinceDays, 21);
  assert.equal(a.deps, true);
  assert.equal(parseArgs(["scan", "--unref"]).unreferenced, true);
  assert.equal(parseArgs(["scan"]).sinceDays, 14, "the default window is stated in the help");
});

test("containerOf yields nothing for a probe that inspects no container", () => {
  assert.deepEqual(containerOf(probing(["gh", "--version"])), [], "not a runtime at all");
  assert.deepEqual(containerOf(probing(["podman", "images"])), [], "a runtime, but not inspect");
  // Taking the trailing Go template for a container name would put an
  // expression into the tracked set and quietly stop matching anything.
  assert.deepEqual(containerOf(probing(["podman", "inspect", "--format", "{{.Config.Image}}"])), []);
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
