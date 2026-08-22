// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Engine } from "../src/judge.ts";
import type { OutdatedPackage } from "../src/outdated.ts";
import {
  bucketFor,
  compareEntries,
  compareFor,
  expandOnly,
  namesOf,
  type Overview,
  type OverviewEntry,
  untrackedOutdatedCount,
} from "../src/overview.ts";
import { renderOverview } from "../src/render.ts";
import { referenceCounts } from "../src/usage.ts";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "bumpii-overview-"));
  dirs.push(d);
  return d;
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const ENGINE: Engine = { kind: "claude-cli", model: "haiku", label: "claude-cli/haiku" };

function entry(over: Partial<OverviewEntry> & { name: string }): OverviewEntry {
  return {
    installed: "1.0.0",
    latest: "2.0.0",
    kind: "formula",
    pinned: false,
    tracked: false,
    refs: 0,
    source: null,
    update: `brew upgrade ${over.name}`,
    bucket: "no-signal",
    behind: [],
    // Enough published releases that the default entry does not accidentally
    // exercise the "publishes no versioned releases" branch.
    published: 1,
    truncated: false,
    items: [],
    compare: null,
    ...over,
  };
}

function overview(over: Partial<Overview>): Overview {
  return {
    entries: [],
    current: [],
    unchecked: [],
    missingUsagePaths: [],
    noUsagePaths: false,
    filteredOut: 0,
    engine: ENGINE,
    ...over,
  };
}

test("reference counts are per name, counting each file once", async () => {
  const d = await scratch();
  await writeFile(join(d, "a.sh"), "gh pr list\ngh pr view\njq .\n", "utf8");
  await writeFile(join(d, "b.sh"), "gh auth status\n", "utf8");
  const { counts } = await referenceCounts([d], ["gh", "jq", "restic"]);
  // Two mentions of gh in a.sh are one file, not two.
  assert.equal(counts.get("gh"), 2);
  assert.equal(counts.get("jq"), 1);
  // A name nothing matches must come back as 0, not be absent — the caller
  // reads the number straight out, and `undefined` would sort as NaN.
  assert.equal(counts.get("restic"), 0);
});

test("reference counts match whole words, so a ranking is not built on substrings", async () => {
  const d = await scratch();
  // The real failure this guards: "tea" inside "instead" outnumbered its own
  // genuine hits 3-to-1 on a real machine, which would rank it above tools
  // called far more often.
  await writeFile(join(d, "notes.md"), "instead of that, the team decided\n", "utf8");
  await writeFile(join(d, "real.sh"), "tea pr list\n", "utf8");
  assert.equal((await referenceCounts([d], ["tea"])).counts.get("tea"), 1);
});

test("reference counts survive a filename containing a colon", async () => {
  const d = await scratch();
  // The output is "path:match", and splitting at the first colon would take
  // half a path as the filename and the rest as the package name.
  await writeFile(join(d, "weird:name.sh"), "gh pr list\n", "utf8");
  assert.equal((await referenceCounts([d], ["gh"])).counts.get("gh"), 1);
});

test("expandOnly widens --only through every alias a tracked tool answers to", () => {
  // `bumpii overview --only fj` with `forgejo-cli` outdated used to report
  // "nothing matched": the pending half filtered on brew's name while the
  // quiet half matched every alias, so the tool vanished between the two.
  const fj = {
    name: "fj",
    source: "codeberg:forgejo-contrib/forgejo-cli",
    version: { cmd: ["fj", "version"], match: "fj v?([0-9][0-9.]*)" },
    update: "brew upgrade forgejo-cli",
  };
  const only = expandOnly(["fj"], [fj]);
  assert.ok(only.has("forgejo-cli"), "the formula name brew prints has to match too");
  assert.ok(only.has("fj"));
  assert.equal(expandOnly(["unrelated"], [fj]).size, 1, "an alias of nothing stays itself");
  assert.equal(expandOnly([], [fj]).size, 0, "no --only means no filter, not a filter on aliases");
});

test("an empty usagePaths config is called out in the overview", () => {
  // Everything lands under "no signal" because nothing was searched — without
  // this line the report asserts absence about paths nobody ever gave it.
  const out = renderOverview(overview({ noUsagePaths: true }));
  assert.match(out, /no usagePaths configured/);
  assert.match(out, /buckets above mean nothing/);
  assert.doesNotMatch(renderOverview(overview({})), /no usagePaths configured/);
});

test("releases published without notes say so, instead of blaming the engine", () => {
  // htop's real shape: it tags every version and writes no body. There is
  // nothing to read, which is a fact about the forge — reporting it as a failed
  // digest sends the reader to check a model that did exactly what it could.
  const bare = (version: string) => ({
    tag: version,
    version,
    publishedAt: null,
    notes: "",
    url: `https://github.com/htop-dev/htop/releases/tag/${version}`,
  });
  const out = renderOverview(
    overview({
      entries: [
        entry({
          name: "htop",
          refs: 1,
          source: "github:htop-dev/htop",
          bucket: "undigested",
          behind: [bare("3.5.3")],
          published: 4,
        }),
      ],
    }),
  );
  assert.match(out, /the forge published this release without notes/);
  assert.doesNotMatch(out, /raw notes:/);
  // The two neighbouring silences make different claims and must not be
  // borrowed for this one.
  assert.doesNotMatch(out, /publishes no versioned releases/);
  assert.doesNotMatch(out, /published no release between these versions/);
});

test("a release that does carry notes still reports why it was not digested", () => {
  // The engine-failure branch has to survive the one added above it: a real
  // digest failure over real notes is still the engine's to explain.
  const out = renderOverview(
    overview({
      entries: [
        entry({
          name: "gh",
          refs: 1,
          source: "github:cli/cli",
          bucket: "undigested",
          behind: [
            {
              tag: "v2.97.0",
              version: "2.97.0",
              publishedAt: null,
              notes: "Fixed `gh pr view --json`",
              url: "https://github.com/cli/cli/releases/tag/v2.97.0",
            },
          ],
          published: 4,
          error: "engine exploded",
        }),
      ],
    }),
  );
  assert.match(out, /raw notes:/);
  assert.doesNotMatch(out, /without notes/);
});

test("a tool answers to its binary name and its formula name alike", () => {
  // The shipped default config: keyed on the binary, upgraded by the formula.
  // Losing either name is what let brew's `forgejo-cli` be counted while every
  // script says `fj`.
  const got = namesOf({
    name: "fj",
    source: "codeberg:forgejo-contrib/forgejo-cli",
    version: { cmd: ["fj", "version"], match: "fj v?([0-9][0-9.]*)" },
    update: "brew upgrade forgejo-cli",
  });
  assert.deepEqual(got.sort(), ["fj", "forgejo-cli"]);
});

test("a tap-qualified formula also answers to its last segment", () => {
  const got = namesOf({
    name: "thing",
    source: "github:o/r",
    version: { cmd: ["thing", "--version"], match: "([0-9.]+)" },
    update: "brew upgrade someone/tap/thing",
  });
  assert.ok(got.includes("someone/tap/thing"), "the full tap-qualified name");
  assert.ok(got.includes("thing"), "and the short name brew prints");
});

const outdated = (name: string, over: Partial<OutdatedPackage> = {}): OutdatedPackage => ({
  name,
  installed: "1.0.0",
  latest: "2.0.0",
  kind: "formula",
  pinned: false,
  ...over,
});

test("untrackedOutdatedCount counts what tools.json never named", () => {
  const tools = [
    {
      name: "gh",
      source: "github:cli/cli",
      version: { cmd: ["gh", "--version"], match: "gh version ([0-9.]+)" },
      update: "brew upgrade gh",
    },
  ];
  const count = untrackedOutdatedCount([outdated("gh"), outdated("libffi"), outdated("openldap")], tools);
  assert.equal(count, 2, "gh is tracked, the other two are not");
});

test("untrackedOutdatedCount matches a tracked tool under its formula name too", () => {
  // The bug namesOf exists to prevent, applied here: brew reports the formula
  // (forgejo-cli), not the binary (fj) the tool is keyed on.
  const tools = [
    {
      name: "fj",
      source: "codeberg:forgejo-contrib/forgejo-cli",
      version: { cmd: ["fj", "version"], match: "fj v?([0-9.]+)" },
      update: "brew upgrade forgejo-cli",
    },
  ];
  assert.equal(untrackedOutdatedCount([outdated("forgejo-cli")], tools), 0);
});

test("untrackedOutdatedCount is zero when brew has nothing pending", () => {
  assert.equal(untrackedOutdatedCount([], []), 0);
});

test("reference counts are taken across every name a tool answers to", async () => {
  // The bug this guards, end to end: brew says `forgejo-cli`, the files say
  // `fj`, and taking brew's name alone reports the tool as unreferenced.
  const d = await scratch();
  for (const n of ["a", "b", "c"]) await writeFile(join(d, `${n}.sh`), "fj pr list\n", "utf8");
  const tool = {
    name: "fj",
    source: "codeberg:forgejo-contrib/forgejo-cli",
    version: { cmd: ["fj", "version"], match: "fj v?([0-9][0-9.]*)" },
    update: "brew upgrade forgejo-cli",
  };
  const { counts } = await referenceCounts([d], namesOf(tool));
  assert.equal(counts.get("forgejo-cli"), 0, "brew's name appears nowhere");
  const best = Math.max(...namesOf(tool).map((n) => counts.get(n) ?? 0));
  assert.equal(best, 3, "but the tool is named in three files under its binary name");
});

test("a clean --only slice does not claim the whole machine is clean", () => {
  // `overview --only fj` with five other packages pending used to headline
  // "brew has no newer version for anything installed" — literally false, and
  // exactly the kind of confident over-claim the report exists to avoid.
  const sliced = renderOverview(overview({ filteredOut: 5 }));
  assert.match(sliced, /nothing outdated among what --only names/);
  assert.match(sliced, /5 packages pending outside that filter/);
  assert.doesNotMatch(sliced, /anything installed/);

  const whole = renderOverview(overview({}));
  assert.match(whole, /anything installed/);
});

test("an empty overview says nothing is outdated, not nothing is known", () => {
  const text = renderOverview(overview({}));
  assert.match(text, /nothing outdated/);
  assert.doesNotMatch(text, /digested/);
});

test("unreferenced packages are listed but never described as judged", () => {
  const text = renderOverview(
    overview({
      entries: [entry({ name: "harfbuzz", installed: "14.2.1", latest: "14.3.0", refs: 0 })],
    }),
  );
  assert.match(text, /no signal \(1\)/);
  assert.match(text, /harfbuzz\s+14\.2\.1 → 14\.3\.0/);
  // The reason has to be on screen: an unexplained bucket reads as a tool that
  // gave up rather than one that declined to guess.
  assert.match(text, /no file in your usagePaths names these/);
});

test("an unreferenced entry still gets the link the heading promises", () => {
  // The heading says "version and link only", so a resolvable source has to
  // produce one. Sources used to be looked up for referenced packages alone,
  // which made that promise false for exactly the entries it describes.
  const text = renderOverview(
    overview({
      entries: [entry({ name: "harfbuzz", refs: 0, source: "github:harfbuzz/harfbuzz" })],
    }),
  );
  assert.match(text, /https:\/\/github\.com\/harfbuzz\/harfbuzz\/releases/);
});

test("a referenced package with no forge repo says so instead of guessing", () => {
  const text = renderOverview(
    overview({
      entries: [entry({ name: "node", installed: "26.5.0", latest: "26.7.0", refs: 14, bucket: "no-repo" })],
    }),
  );
  assert.match(text, /no forge repo in its brew URLs/);
  assert.match(text, /bumpii add node --source github:owner\/repo/);
});

test("tracked but not brew-managed is kept apart from up to date", () => {
  const text = renderOverview(
    overview({
      current: [{ name: "gh", installed: "2.97.0", refs: 34 }],
      unchecked: [{ name: "home-assistant", refs: 2, reason: "not-brew" }],
    }),
  );
  assert.match(text, /tracked, up to date/);
  assert.match(text, /gh 2\.97\.0/);
  // The container entry must not appear under "up to date": brew never checked
  // it, and saying it is current would be a claim nothing supports.
  assert.match(text, /tracked, not covered here/);
  assert.match(text, /brew does not manage these/);
  const upToDate = text.slice(text.indexOf("tracked, up to date"), text.indexOf("tracked, not covered"));
  assert.doesNotMatch(upToDate, /home-assistant/);
});

test("a tracked formula brew does not have installed is not called up to date", () => {
  // brew is equally silent about "current" and "never installed", and only one
  // of those is up to date.
  const text = renderOverview(
    overview({ unchecked: [{ name: "ripgrep", refs: 3, reason: "not-installed" }] }),
  );
  assert.match(text, /tracked, not installed/);
  assert.match(text, /nothing was checked, and nothing is up to date/);
  assert.doesNotMatch(text, /up to date\n\s+ripgrep/);
});

test("a pinned package is marked, so its update line is not read as a no-op", () => {
  const text = renderOverview(overview({ entries: [entry({ name: "cmake", refs: 0, pinned: true })] }));
  assert.match(text, /pinned/);
});

test("missing usagePaths are reported as undermining the buckets themselves", () => {
  const text = renderOverview(
    overview({
      entries: [entry({ name: "glib", refs: 0 })],
      missingUsagePaths: ["~/gone"],
    }),
  );
  assert.match(text, /usagePaths not found: ~\/gone/);
  assert.match(text, /buckets they sort into — are incomplete/);
});

test("digested entries show the compare link and the classified items", () => {
  const text = renderOverview(
    overview({
      entries: [
        entry({
          name: "gh",
          installed: "2.96.0",
          latest: "2.97.0",
          refs: 34,
          tracked: true,
          bucket: "digested",
          source: "github:cli/cli",
          compare: "https://github.com/cli/cli/compare/v2.96.0...v2.97.0",
          behind: [
            {
              tag: "v2.97.0",
              version: "2.97.0",
              publishedAt: null,
              notes: "",
              url: "https://github.com/cli/cli/releases/tag/v2.97.0",
            },
          ],
          items: [
            {
              kind: "security",
              summary: "Authorization header leaked to TUF mirrors",
              version: "2.97.0",
            },
          ],
        }),
      ],
    }),
  );
  assert.match(text, /★ digested/);
  assert.match(text, /https:\/\/github\.com\/cli\/cli\/compare\/v2\.96\.0\.\.\.v2\.97\.0/);
  assert.match(text, /! security/);
  // The command layer is gone: a report that classifies changes must not also
  // claim to know which of them touch you. If this string comes back, half a
  // layer came back with it.
  assert.doesNotMatch(text, /affects you|you use this|mentions commands/);
});

test("an untracked package that was judged is offered for tracking", () => {
  const text = renderOverview(
    overview({
      entries: [entry({ name: "docker", refs: 20, bucket: "digested", tracked: false })],
    }),
  );
  assert.match(text, /worth tracking: bumpii add docker/);
});

test("brew ahead of the forge is not rendered as a failed digest", () => {
  const text = renderOverview(
    overview({
      // A revision bump (0.41.0_6 → 0.41.0_7) moves brew's version without any
      // release behind it. Blaming the engine there sends the reader to check a
      // model that was never asked anything.
      entries: [
        entry({ name: "some-tool", refs: 5, bucket: "undigested", behind: [], items: [], published: 9 }),
      ],
    }),
  );
  assert.match(text, /forge published no release between these versions/);
  assert.doesNotMatch(text, /engine returned nothing usable/);
});

test("a repo that publishes no releases is not reported as nothing having changed", () => {
  // `published: 0` and `behind: []` render identically unless they are told
  // apart — one means "nothing changed", the other "nothing could be compared".
  const text = renderOverview(
    overview({
      entries: [
        entry({
          name: "some-tool",
          refs: 5,
          bucket: "undigested",
          source: "github:o/r",
          behind: [],
          items: [],
          published: 0,
        }),
      ],
    }),
  );
  assert.match(text, /publishes no versioned releases/);
  assert.doesNotMatch(text, /no release between these versions/);
});

test("the compare link is refused when its exact range is unknown", () => {
  const rel = (version: string, tag: string) => ({
    tag,
    version,
    publishedAt: null,
    notes: "",
    url: `https://example.com/${tag}`,
  });
  const releases = [rel("1.2.4", "v1.2.4"), rel("1.2.3", "v1.2.3")];

  // Both ends published: an exact range, and a link.
  assert.equal(
    compareFor("github:o/r", releases, "1.2.3", "1.2.4"),
    "https://github.com/o/r/compare/v1.2.3...v1.2.4",
  );
  // brew offers a revision bump the forge never tagged. Linking v1.2.3...v1.2.4
  // here would describe a release the upgrade does not contain.
  assert.equal(compareFor("github:o/r", releases, "1.2.3", "1.2.3_2"), null);
  // Installed version predates the page: the lower bound is unknown.
  assert.equal(compareFor("github:o/r", releases, "0.9.0", "1.2.4"), null);
});

test("the bucket follows the facts, and an empty digest is never called digested", () => {
  // The decision itself, not the rendering of it: a renderer test built from a
  // hand-written entry stays green no matter what buildOverview assigns, which
  // is how "★ digested" came to sit above an entry reading "digest failed".
  const b = (f: Parameters<typeof bucketFor>[0]) => bucketFor(f);
  assert.equal(b({ refs: 0, source: "github:o/r", itemCount: 3 }), "no-signal");
  assert.equal(b({ refs: 5, source: null, itemCount: 0 }), "no-repo");
  assert.equal(b({ refs: 5, source: "github:o/r", unreachable: true, itemCount: 0 }), "unreachable");
  assert.equal(b({ refs: 5, source: "github:o/r", itemCount: 3 }), "digested");
  // The engine was off, failed, or returned nothing — all three are this.
  assert.equal(b({ refs: 5, source: "github:o/r", itemCount: 0 }), "undigested");
  // Unreferenced wins over everything: nothing is judged without usage behind
  // it, so it cannot be "digested" even if items somehow exist.
  assert.equal(b({ refs: 0, source: null, itemCount: 0 }), "no-signal");
});

test("an entry the engine could not digest is not counted as digested", () => {
  const text = renderOverview(
    overview({
      entries: [
        entry({
          name: "some-tool",
          refs: 5,
          bucket: "undigested",
          behind: [
            { tag: "v2", version: "2.0.0", publishedAt: null, notes: "", url: "https://example.com/r/2" },
          ],
          items: [],
          error: "engine timed out",
        }),
      ],
    }),
  );
  assert.match(text, /pending, not digested/);
  assert.match(text, /digest failed: engine timed out/);
  // The tally has to agree with the heading.
  assert.match(text, /1 pending — 0 digested · 1 not digested/);
});

test("the release count carries a + when the forge page ran out first", () => {
  const behind = Array.from({ length: 30 }, (_, i) => ({
    tag: `v${i}`,
    version: `1.0.${i}`,
    publishedAt: null,
    notes: "",
    url: `https://example.com/r/${i}`,
  }));
  const text = renderOverview(
    overview({
      entries: [entry({ name: "some-tool", refs: 5, bucket: "undigested", behind, truncated: true })],
    }),
  );
  assert.match(text, /30\+ releases/);
});

// Nothing checked this order before, because it lived inside buildOverview and
// every renderer test passes a single entry. That is how "undigested" came to
// be missing from ORDER: indexOf returned -1 and sorted it ahead of everything,
// which the text report hides (render.ts filters per bucket) and --json shows.
test("entries sort by bucket, then by references, then by name", () => {
  const e = (name: string, bucket: OverviewEntry["bucket"], refs: number) => entry({ name, bucket, refs });
  const sorted = [
    e("zulu", "no-signal", 99),
    e("alpha", "unreachable", 1),
    e("bravo", "no-repo", 3),
    e("pending", "undigested", 50),
    e("charlie", "digested", 2),
    e("delta", "digested", 40),
    e("echo", "digested", 40),
  ]
    .sort(compareEntries)
    .map((x) => x.name);
  assert.deepEqual(sorted, [
    // digested first, most-referenced first, ties broken by name
    "delta",
    "echo",
    "charlie",
    // then the bucket that means "read, but nothing came back"
    "pending",
    "bravo",
    "alpha",
    // unreferenced last, however high its own count
    "zulu",
  ]);
});

// brew prints yt-dlp as 2026.7.4, the forge tags it 2026.07.04. compareVersions
// calls those equal — which is why "1 release behind" was right — but tagFor
// compared the strings, found nothing, and dropped a compare link that resolves
// perfectly. Two comparison rules for the same pair of versions.
test("a compare link survives brew and the forge padding versions differently", () => {
  const rel = (version: string, tag: string) => ({
    tag,
    version,
    publishedAt: null,
    notes: "",
    url: `https://example.com/${tag}`,
  });
  const releases = [rel("2026.08.19", "2026.08.19"), rel("2026.07.04", "2026.07.04")];

  assert.equal(
    compareFor("github:yt-dlp/yt-dlp", releases, "2026.7.4", "2026.8.19"),
    "https://github.com/yt-dlp/yt-dlp/compare/2026.07.04...2026.08.19",
  );

  // The other half of the pair, asserted here so a later rewrite cannot fix one
  // by breaking the other: a revision bump is NOT the same version written
  // differently, and still gets no link.
  const tagged = [rel("1.2.4", "v1.2.4"), rel("1.2.3", "v1.2.3")];
  assert.equal(compareFor("github:o/r", tagged, "1.2.3", "1.2.3_2"), null);
  // Nor does a letter suffix collapse into its base version.
  const lettered = [rel("3.5a", "v3.5a"), rel("3.5", "v3.5")];
  assert.equal(
    compareFor("github:o/r", lettered, "3.5", "3.5a"),
    "https://github.com/o/r/compare/v3.5...v3.5a",
  );
});
