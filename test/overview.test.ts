// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Engine } from "../src/judge.ts";
import type { Overview, OverviewEntry } from "../src/overview.ts";
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
    items: [],
    hits: [],
    compare: null,
    ...over,
  };
}

function overview(over: Partial<Overview>): Overview {
  return { entries: [], current: [], unchecked: [], missingUsagePaths: [], engine: ENGINE, ...over };
}

test("reference counts are per name, counting each file once", async () => {
  const d = await scratch();
  await writeFile(join(d, "a.sh"), "gh pr list\ngh pr view\njq .\n", "utf8");
  await writeFile(join(d, "b.sh"), "gh auth status\n", "utf8");
  const counts = await referenceCounts([d], ["gh", "jq", "restic"]);
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
  assert.equal((await referenceCounts([d], ["tea"])).get("tea"), 1);
});

test("reference counts survive a filename containing a colon", async () => {
  const d = await scratch();
  // The output is "path:match", and splitting at the first colon would take
  // half a path as the filename and the rest as the package name.
  await writeFile(join(d, "weird:name.sh"), "gh pr list\n", "utf8");
  assert.equal((await referenceCounts([d], ["gh"])).get("gh"), 1);
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
      unchecked: [{ name: "home-assistant", refs: 2 }],
    }),
  );
  assert.match(text, /referenced, up to date/);
  assert.match(text, /gh 2\.97\.0/);
  // The container entry must not appear under "up to date": brew never checked
  // it, and saying it is current would be a claim nothing supports.
  assert.match(text, /tracked, not covered here/);
  assert.match(text, /brew does not manage these/);
  const upToDate = text.slice(text.indexOf("referenced, up to date"), text.indexOf("tracked, not covered"));
  assert.doesNotMatch(upToDate, /home-assistant/);
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

test("digested entries show the compare link and what it touches", () => {
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
              commands: ["gh attestation verify"],
              version: "2.97.0",
            },
          ],
          hits: [{ command: "gh attestation verify", file: "~/ops/scripts/x.sh", line: 3 }],
        }),
      ],
    }),
  );
  assert.match(text, /★ digested/);
  assert.match(text, /https:\/\/github\.com\/cli\/cli\/compare\/v2\.96\.0\.\.\.v2\.97\.0/);
  assert.match(text, /! security/);
  assert.match(text, /you use this: ~\/ops\/scripts\/x\.sh/);
  assert.match(text, /affects you: 1 of 1 changes/);
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
      // A revision bump (mpv 0.41.0_6 → 0.41.0_7) moves brew's version without
      // any release behind it. Blaming the engine there sends the reader to
      // check a model that was never asked anything.
      entries: [entry({ name: "mpv", refs: 5, bucket: "digested", behind: [], items: [] })],
    }),
  );
  assert.match(text, /forge published no release notes between these versions/);
  assert.doesNotMatch(text, /engine returned nothing usable/);
});
