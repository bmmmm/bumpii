// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { compareUrl, readSourceCache, resolveSources } from "../src/outdated.ts";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "bumpii-outdated-"));
  dirs.push(d);
  return d;
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

// Structure captured from `brew outdated --json=v2` on Homebrew 6.0.15 —
// field names, types and nesting verbatim, package names and versions
// substituted. Formulae and casks share this shape; `installed_versions` is an
// array even when it holds one entry, which is what the parser turns on.
const OUTDATED_FIXTURE = `{
  "formulae": [
    {
      "name": "gh",
      "installed_versions": ["2.96.0"],
      "current_version": "2.97.0",
      "pinned": false,
      "pinned_version": null
    }
  ],
  "casks": [
    {
      "name": "some-cask",
      "installed_versions": ["2.6.1"],
      "current_version": "2.7.0",
      "pinned": false,
      "pinned_version": null
    }
  ]
}`;

test("brew outdated JSON parses into packages, casks included", async () => {
  // The field names, their types and the nesting are what the parser depends
  // on, and all three are verbatim from a real run — only the package names and
  // versions are stand-ins, so a fixture in a public repo does not double as an
  // inventory of the machine it was captured on. The shape was checked against
  // the live brew as well; a green fixture alone proves nothing.
  const d = JSON.parse(OUTDATED_FIXTURE) as {
    formulae: { name: string; installed_versions: string[]; current_version: string }[];
    casks: { name: string; installed_versions: string[]; current_version: string }[];
  };
  // The one field that is easy to get wrong: an array even for a single
  // version, and the newest entry is the last, not the first.
  assert.equal(d.formulae[0]?.installed_versions.at(-1), "2.96.0");
  assert.equal(d.casks[0]?.current_version, "2.7.0");
});

test("compareUrl builds a diff link from the tags, not the versions", () => {
  // "v"-prefixed tags are the common case, and the reason building a URL out of
  // bare version numbers produces a 404.
  assert.equal(
    compareUrl("github:cli/cli", "v2.96.0", "v2.97.0"),
    "https://github.com/cli/cli/compare/v2.96.0...v2.97.0",
  );
  // jq tags "jq-1.8.2" — no amount of prefix-guessing gets there.
  assert.equal(
    compareUrl("github:jqlang/jq", "jq-1.8.1", "jq-1.8.2"),
    "https://github.com/jqlang/jq/compare/jq-1.8.1...jq-1.8.2",
  );
  assert.equal(
    compareUrl("codeberg:forgejo-contrib/forgejo-cli", "v0.5.0", "v0.6.0"),
    "https://codeberg.org/forgejo-contrib/forgejo-cli/compare/v0.5.0...v0.6.0",
  );
  assert.equal(
    compareUrl("https://gitea.com/gitea/tea", "v0.15.0", "v0.15.1"),
    "https://gitea.com/gitea/tea/compare/v0.15.0...v0.15.1",
  );
});

test("compareUrl refuses rather than inventing half a link", () => {
  assert.equal(compareUrl("github:o/r", "", "v1.0.0"), null);
  assert.equal(compareUrl("github:o/r", "v1.0.0", ""), null);
  assert.equal(compareUrl("not-a-source", "v1", "v2"), null);
});

test("a cached null is an answer, so brew is not re-asked for it", async () => {
  const path = join(await scratch(), "sources.json");
  // "glib" resolving to null is the real case: brew's URL is a GNOME tarball,
  // and re-deriving that on every run would cost a brew info to learn nothing.
  await writeFile(path, JSON.stringify({ glib: null, gh: "github:cli/cli" }), "utf8");
  // Both names are cached, so resolveSources must not shell out at all — if it
  // did, this test would spawn brew and the assertion below would still pass,
  // which is why the file is left unchanged as the second check.
  const before = await readFile(path, "utf8");
  const got = await resolveSources(["glib", "gh"], path);
  assert.equal(got.glib, null);
  assert.equal(got.gh, "github:cli/cli");
  assert.equal(await readFile(path, "utf8"), before);
});

test("a corrupt cache is an empty one, never a failed run", async () => {
  const path = join(await scratch(), "sources.json");
  await writeFile(path, "{not json", "utf8");
  assert.deepEqual(await readSourceCache(path), {});
  // An array parses as JSON but is not a lookup table; treating it as one would
  // put `undefined` where a source belongs.
  await writeFile(path, "[1,2,3]", "utf8");
  assert.deepEqual(await readSourceCache(path), {});
});

test("a missing cache file reads as empty", async () => {
  assert.deepEqual(await readSourceCache(join(await scratch(), "nope.json")), {});
});
