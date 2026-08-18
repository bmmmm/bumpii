// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  compareUrl,
  installedVersionMap,
  readSourceCache,
  resolveSources,
  toPackages,
} from "../src/outdated.ts";

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

test("brew outdated JSON parses into packages, casks included", () => {
  // Driven through the real parser, not re-implemented in the test: asserting
  // on `JSON.parse(fixture).formulae[0].installed_versions.at(-1)` here would
  // stay green while toPackages itself took `[0]`, which is the exact rule its
  // comment exists to protect.
  const d = JSON.parse(OUTDATED_FIXTURE) as { formulae: unknown[]; casks: unknown[] };
  const got = [
    ...toPackages(d.formulae as Parameters<typeof toPackages>[0], "formula"),
    ...toPackages(d.casks as Parameters<typeof toPackages>[0], "cask"),
  ];
  assert.deepEqual(got, [
    { name: "gh", installed: "2.96.0", latest: "2.97.0", kind: "formula", pinned: false },
    { name: "some-cask", installed: "2.6.1", latest: "2.7.0", kind: "cask", pinned: false },
  ]);
});

test("the newest kept version is the one compared against, not the oldest", () => {
  // brew lists every kept-back version, oldest first. Taking the head would
  // report a package as further behind than it is.
  const got = toPackages(
    [{ name: "x", installed_versions: ["1.0.0", "1.4.0"], current_version: "2.0.0" }],
    "formula",
  );
  assert.equal(got[0]?.installed, "1.4.0");
});

test("an entry missing a version is dropped, not turned into an empty comparison", () => {
  const got = toPackages(
    [
      { name: "no-current", installed_versions: ["1.0.0"] },
      { name: "no-installed", current_version: "2.0.0" },
      { installed_versions: ["1.0.0"], current_version: "2.0.0" },
    ],
    "formula",
  );
  assert.deepEqual(got, []);
});

test("pinned survives the parse, since brew lists pinned packages it will not move", () => {
  const got = toPackages(
    [{ name: "x", installed_versions: ["1.0.0"], current_version: "2.0.0", pinned: true }],
    "formula",
  );
  assert.equal(got[0]?.pinned, true);
});

test("installedVersionMap answers under the name that was asked, tap-qualified included", () => {
  // The caller asks with the name its `brew upgrade` line carries
  // (jundot/omlx/omlx); brew prints the bare name (omlx). A map keyed only on
  // what brew printed answered undefined for an installed formula, which the
  // overview reported as "brew manages these but does not have them".
  const map = installedVersionMap(["jundot/omlx/omlx", "gh"], "omlx 0.5.6 0.5.7\ngh 2.97.0\n", "");
  assert.equal(map.get("jundot/omlx/omlx"), "0.5.7", "the newest kept version, under the asked name");
  assert.equal(map.get("gh"), "2.97.0");
  assert.equal(map.get("absent"), undefined, "a name brew does not manage stays absent");
});

test("a name that is both formula and cask answers with the formula's version", () => {
  const map = installedVersionMap(["wireshark"], "wireshark 4.0.0\n", "wireshark 3.9.9\n");
  assert.equal(map.get("wireshark"), "4.0.0");
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

test("a tapped formula resolves under the name it was asked for", async () => {
  // brew is asked for `jundot/omlx/omlx` — the name its `brew upgrade` line
  // carries — and answers with the short name in `name` and the full one only
  // in `full_name`. brewSources keyed the map on `name` alone, so the lookup
  // missed, resolveSources wrote null, and the `!(n in cache)` gate meant it
  // was never asked again: overview printed "no forge repo in its brew URLs"
  // for a formula whose forge brew had just named. Found in the real cache:
  // `"jundot/omlx/omlx": null` sitting beside working entries.
  //
  // discover.ts already indexes both names (brewJsonMany); this is the same
  // shape, in the module that never learned it.
  const dir = await scratch();
  await writeFile(
    join(dir, "brew"),
    `#!/bin/sh\nprintf '%s' '${JSON.stringify({
      formulae: [
        {
          name: "omlx",
          full_name: "jundot/omlx/omlx",
          homepage: "https://github.com/jundot/omlx",
          urls: { stable: { url: "https://github.com/jundot/omlx/archive/v0.5.7.tar.gz" } },
        },
      ],
    })}'\n`,
    "utf8",
  );
  await chmod(join(dir, "brew"), 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${dir}:${realPath}`;
  try {
    const path = join(dir, "sources.json");
    const got = await resolveSources(["jundot/omlx/omlx"], path);
    assert.equal(got["jundot/omlx/omlx"], "github:jundot/omlx", "the name asked for must carry the answer");
  } finally {
    process.env.PATH = realPath;
  }
});

test("a null cached under a tap-qualified name is asked again, not kept", async () => {
  // The nulls already on disk were written by the bug above, and `!(n in
  // cache)` treats them as settled answers — so the fix alone would never
  // reach the machines that need it.
  const path = join(await scratch(), "sources.json");
  await writeFile(
    path,
    JSON.stringify({ glib: null, "jundot/omlx/omlx": null, gh: "github:cli/cli" }),
    "utf8",
  );
  const cache = await readSourceCache(path);
  assert.equal("glib" in cache, true, "a plain name brew genuinely could not place stays settled");
  assert.equal("jundot/omlx/omlx" in cache, false, "a tapped null is dropped so it gets one more chance");
  assert.equal(cache.gh, "github:cli/cli", "a name that did resolve is untouched");
});
