// SPDX-License-Identifier: GPL-3.0-or-later
// `bumpii notes` and `scan --unmapped` below the CLI: where a name's notes are
// found, what a page reduces to, and which states must never read as success.
//
// gh is stubbed away first, as in sources.test.ts, so a GitHub source in here
// never depends on whether this machine is logged in.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Config, Release } from "../src/types.ts";

const ghDir = mkdtempSync(join(tmpdir(), "bumpii-nogh-"));
writeFileSync(join(ghDir, "gh"), "#!/bin/sh\nexit 1\n");
chmodSync(join(ghDir, "gh"), 0o755);
const realPath = process.env.PATH;
process.env.PATH = ghDir;

const { coverage, fetchPage, hasNotes, pageText, pickReleases, readNotes, resolveTarget, unmappedCount } =
  await import("../src/notes.ts");
const { renderCoverage, renderNotes } = await import("../src/render.ts");

after(async () => {
  process.env.PATH = realPath;
  await rm(ghDir, { recursive: true, force: true });
});

const ESC = "\x1b";

/** A fetch answering by URL; a URL not in the table is a transport failure. */
function stubFetch(table: Record<string, { status?: number; body: unknown; type?: string }>): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const hit = table[String(url)];
    if (!hit) throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    const status = hit.status ?? 200;
    const text = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Server Error",
      headers: new Headers({ "content-type": hit.type ?? "application/json" }),
      json: async () => hit.body,
      text: async () => text,
    };
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const rel = (tag: string, notes = `notes for ${tag}`): Release => ({
  tag,
  version: tag.replace(/^[^0-9]*/, ""),
  publishedAt: "2026-01-01T00:00:00Z",
  notes,
  url: `https://example.com/${tag}`,
});

const config = (over: Partial<Config> = {}): Config => ({ usagePaths: [], tools: [], packages: {}, ...over });
const pkg = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  kind: "cask" as const,
  version: "3.2.1",
  derived: null,
  ...over,
});

test("pageText keeps what a person reads and drops the page around it", () => {
  const html = `<html><head><title>t</title><style>p{}</style></head><body>
    <nav><a>Home</a> <a>Download</a></nav>
    <script>var tracker = 1;</script>
    <main><h1>Netscope 3.2.1 Release Notes</h1>
    <p>Fixed &amp; improved &lt;dissectors&gt; &#8212; see&nbsp;below.</p>
    <ul><li><p>CVE-2026-1</p></li><li>CVE-2026-2</li></ul></main>
    <footer>© the foundation</footer></body></html>`;
  const text = pageText(html);
  assert.match(text, /^Netscope 3\.2\.1 Release Notes$/m);
  assert.match(text, /^Fixed & improved <dissectors> — see below\.$/m);
  assert.match(text, /^- CVE-2026-1$/m, "a bullet whose text sits in a <p> stays on its line");
  assert.match(text, /^- CVE-2026-2$/m);
  assert.doesNotMatch(text, /tracker|Download|foundation|<\/?(p|li|ul|main|h1)>|p\{\}/);
});

test("pageText does not read a custom element as the tag its name begins with", () => {
  // A hyphen is a word boundary, so `<nav-tabs>` used to open a <nav> that the
  // footer's </nav> closed — the notes between them gone, and the run still
  // saying "text extracted from that page".
  const html =
    "<main><h1>Release 2.0</h1><nav-tabs>a</nav-tabs><svg-icon></svg-icon><p>Fixed the frobnicator.</p></main>" +
    "<footer><nav>x</nav><svg></svg></footer>";
  assert.equal(pageText(html), "Release 2.0\naFixed the frobnicator.");
});

test("pageText takes the whole body when the page marks no main content", () => {
  assert.equal(pageText("<body><h2>4.2</h2><p>one</p><p>two</p></body>"), "4.2\none\ntwo");
});

test("a page reached as plain text passes through, and an HTML page is reduced", async () => {
  const restore = stubFetch({
    "https://x.org/NEWS": { body: "Noteworthy changes in release 5.3\n<not a tag>", type: "text/plain" },
    "https://x.org/r.html": { body: "<p>a</p><p>b</p>", type: "text/html; charset=utf-8" },
    "https://x.org/gone": { status: 500, body: "" },
  });
  try {
    assert.equal(
      (await fetchPage("https://x.org/NEWS")).text,
      "Noteworthy changes in release 5.3\n<not a tag>",
    );
    assert.equal((await fetchPage("https://x.org/r.html")).text, "a\nb");
    await assert.rejects(fetchPage("https://x.org/gone"), /500 Server Error from https:\/\/x\.org\/gone/);
    await assert.rejects(
      fetchPage("https://down.example/"),
      /cannot reach down\.example — fetch failed: ECONNREFUSED/,
    );
  } finally {
    restore();
  }
});

test("a versioned formula reads only its own branch, and says so when the branch is absent", () => {
  // A project publishing every branch in one list: lang@8.1 showing the 8.5 notes
  // would be the wrong answer stated confidently.
  const list = [rel("lang-8.5.11"), rel("lang-8.4.26"), rel("lang-8.1.33"), rel("lang-8.10.0")];
  assert.deepEqual(
    pickReleases("lang@8.1", list, 5).picked.map((r) => r.tag),
    ["lang-8.1.33"],
  );
  assert.deepEqual(pickReleases("lang@7.4", list, 5), { picked: [], branch: "7.4" });
  // Not a version after the @: no filter, the forge's order kept.
  assert.deepEqual(
    pickReleases("editor@preview", list, 2).picked.map((r) => r.tag),
    ["lang-8.5.11", "lang-8.4.26"],
  );
});

test("a name resolves through the tool, then the mapping, then brew — and a typo gets suggestions", () => {
  const tool = {
    name: "fj",
    source: "codeberg:forgejo-contrib/forgejo-cli",
    version: { cmd: ["fj"], match: "(.)" },
    update: "brew upgrade forgejo-cli",
  };
  const cfg = config({
    tools: [tool],
    packages: {
      "netscope-app": { page: "https://w.example/netscope-{version}.html" },
      vecdraw: { source: "gitlab:team/vecdraw" },
    },
  });
  const installed = [
    pkg("netscope-app"),
    pkg("vecdraw", { derived: "github:wrong/guess" }),
    pkg("torrentd", { derived: "github:team/torrentd" }),
  ];
  assert.equal(resolveTarget("forgejo-cli", cfg, installed).source, "codeberg:forgejo-contrib/forgejo-cli");
  assert.equal(resolveTarget("vecdraw", cfg, installed).source, "gitlab:team/vecdraw", "the mapping wins");
  assert.equal(resolveTarget("torrentd", cfg, installed).source, "github:team/torrentd");
  assert.equal(resolveTarget("netscope-app", cfg, installed).page, "https://w.example/netscope-3.2.1.html");
  assert.throws(() => resolveTarget("netscope", cfg, installed), /did you mean "netscope-app"\?/);
  assert.throws(() => resolveTarget("zzz", cfg, installed), /named "zzz" — see 'bumpii list'/);
  // brew could not be asked: the reason, not "no such package".
  assert.throws(
    () => resolveTarget("zzz", cfg, null, "brew info failed: boom"),
    /brew could not be asked .* boom/,
  );
});

test("a tool known by an alias reads its brew package's mapping, version and branch", async () => {
  // Tool `lang` upgrades `lang@8.1`. Keyed by the alias, the notes came from
  // the newest branch and the mapping stored under the brew name was unseen.
  const cfg = config({
    tools: [
      { name: "lang", source: "", version: { cmd: ["lang"], match: "(.)" }, update: "brew upgrade lang@8.1" },
    ],
    packages: {
      "lang@8.1": { source: "https://git.example.com/o/lang", page: "https://x.example/lang-{version}" },
    },
  });
  const installed = [pkg("lang@8.1", { kind: "formula", version: "8.1.34" })];
  const t = resolveTarget("lang", cfg, installed);
  assert.equal(t.key, "lang@8.1");
  assert.equal(t.source, "https://git.example.com/o/lang");
  assert.equal(t.page, "https://x.example/lang-8.1.34");
  const restore = stubFetch({
    "https://git.example.com/api/v1/repos/o/lang/releases?limit=30": {
      body: [
        { tag_name: "lang-8.5.0", body: "newest branch" },
        { tag_name: "lang-8.1.34", body: "its own branch" },
      ],
    },
  });
  try {
    const r = await readNotes(t, 1);
    assert.deepEqual(
      r.releases.map((x) => x.tag),
      ["lang-8.1.34"],
    );
  } finally {
    restore();
  }
});

test("a package from a prerelease channel says its notes are the stable ones", async () => {
  // The forge path drops prereleases, so `editor@preview` is shown notes older
  // than the build installed — true only if said.
  const restore = stubFetch({
    "https://git.example.com/api/v1/repos/o/editor/releases?limit=30": {
      body: [
        { tag_name: "v2.0.0-pre", body: "pre", prerelease: true },
        { tag_name: "v1.9.0", body: "stable" },
      ],
    },
  });
  try {
    const cfg = config({ packages: { "editor@preview": { source: "https://git.example.com/o/editor" } } });
    const r = await readNotes(resolveTarget("editor@preview", cfg, [pkg("editor@preview")]), 1);
    assert.match(
      renderNotes(r),
      /installed from @preview — these are its stable releases; prereleases are not read/,
    );
    const plain = await readNotes(
      resolveTarget(
        "editor",
        config({ packages: { editor: { source: "https://git.example.com/o/editor" } } }),
        [],
      ),
      1,
    );
    assert.doesNotMatch(renderNotes(plain), /installed from @/);
  } finally {
    restore();
  }
});

test("a page needing a version brew does not know is shown unfilled and never fetched", async () => {
  const cfg = config({ packages: { app: { page: "https://x.org/app-{version}.html" } } });
  const t = resolveTarget("app", cfg, [pkg("app", { version: null })]);
  assert.equal(t.pageUnfilled, true);
  const restore = stubFetch({});
  try {
    const r = await readNotes(t, 1);
    assert.equal(r.pageError, null, "nothing was fetched, so nothing failed");
    assert.equal(hasNotes(r), false);
    assert.match(renderNotes(r), /version unknown — link not filled, page not read/);
  } finally {
    restore();
  }
});

test("empty release bodies are named as such, and the page is read in their place", async () => {
  // Some projects publish their GitLab releases with no text at all.
  const restore = stubFetch({
    "https://git.example.com/api/v1/repos/o/pixbench/releases?limit=30": {
      body: [{ tag_name: "PIXBENCH_3_2_6", body: "", html_url: "https://g/r" }],
    },
    "https://pixbench.example.org/news/": {
      body: "<article><h1>Pixbench 3.2.6</h1><p>bug fixes</p></article>",
      type: "text/html",
    },
  });
  try {
    const cfg = config({
      packages: {
        pixbench: {
          source: "https://git.example.com/o/pixbench",
          page: "https://pixbench.example.org/news/",
        },
      },
    });
    const r = await readNotes(resolveTarget("pixbench", cfg, [pkg("pixbench")]), 1);
    assert.equal(hasNotes(r), true);
    const out = renderNotes(r);
    assert.match(out, /PIXBENCH_3_2_6 published no notes/);
    assert.match(out, /text extracted from that page:\n\nPixbench 3\.2\.6\nbug fixes/);
  } finally {
    restore();
  }
});

test("a page is not fetched when the forge already had text to read", async () => {
  // The page is the fallback, not a second copy: with the forge's notes in
  // hand, fetching it costs a request and prints the same news twice.
  const restore = stubFetch({
    "https://git.example.com/api/v1/repos/o/app/releases?limit=30": {
      body: [{ tag_name: "v1.0.0", body: "real notes", html_url: "https://g/r" }],
    },
  });
  try {
    const cfg = config({
      packages: { app: { source: "https://git.example.com/o/app", page: "https://unreached.example/notes" } },
    });
    const r = await readNotes(resolveTarget("app", cfg, []), 1);
    assert.equal(r.pageText, null);
    assert.equal(r.pageError, null, "a fetch was attempted: the stub refuses every unlisted URL");
    assert.equal(hasNotes(r), true);
  } finally {
    restore();
  }
});

test("a forge that cannot be read is its own state, not 'no releases', and is not success", async () => {
  const restore = stubFetch({});
  try {
    const cfg = config({ packages: { app: { source: "https://git.example.com/o/app" } } });
    const r = await readNotes(resolveTarget("app", cfg, []), 1);
    assert.equal(hasNotes(r), false);
    const out = renderNotes(r);
    assert.match(out, /could not read its releases: cannot reach git\.example\.com/);
    assert.doesNotMatch(out, /no stable release/);
  } finally {
    restore();
  }
});

test("nothing remote reaches the terminal with its control bytes, the notes least of all", () => {
  const evil = `${ESC}[1A${ESC}[2Kup to date`;
  const out = renderNotes({
    name: "app",
    source: "github:o/r",
    page: `https://x.org/${ESC}]8;;`,
    pageUnfilled: false,
    none: null,
    releases: [
      // publishedAt too: a self-hosted forge sends whatever it likes there,
      // and `ESC[2J ESC[3J` wipes the screen and the scrollback.
      { ...rel("v1.0.0"), notes: `line ${evil}`, tag: `v1${ESC}[2K`, publishedAt: `${ESC}[2J${ESC}[3J` },
    ],
    releasesError: null,
    branch: null,
    channel: `pre${ESC}[2K`,
    pageText: `page ${evil}`,
    pageTruncated: false,
    pageError: null,
    key: "app",
  });
  assert.equal(out.includes(ESC), false);
  assert.match(out, /line \[1A\[2Kup to date/, "stripped, not dropped");
});

test("scan --unmapped sorts every package into one state, and an unread forge is never mapped", async () => {
  const restore = stubFetch({
    "https://git.example.com/api/v1/repos/o/good/releases?limit=30": {
      body: [{ tag_name: "v1", body: "text" }],
    },
    "https://git.example.com/api/v1/repos/o/tagsonly/releases?limit=30": { body: [] },
    "https://git.example.com/api/v1/repos/o/empty/releases?limit=30": {
      body: [{ tag_name: "v1", body: "" }],
    },
    // A repo whose newest few releases are prereleases, with a stable one and
    // text sits further down. Read five deep, this was "publishes no releases".
    "https://git.example.com/api/v1/repos/o/prerel/releases?limit=30": {
      body: [
        ...[1, 2, 3, 4, 5].map((n) => ({ tag_name: `v2.0.0-alpha.${n}`, body: "pre", prerelease: true })),
        { tag_name: "v1.9.0", body: "stable notes" },
      ],
    },
  });
  try {
    const cfg = config({
      packages: {
        paged: { page: "https://x.org/notes" },
        closed: { none: "publishes no changelog" },
      },
    });
    const installed = [
      pkg("good", { derived: "https://git.example.com/o/good" }),
      pkg("prerel", { derived: "https://git.example.com/o/prerel" }),
      pkg("tagsonly", { derived: "https://git.example.com/o/tagsonly" }),
      pkg("empty", { derived: "https://git.example.com/o/empty" }),
      pkg("down", { derived: "https://down.example/o/down" }),
      pkg("paged"),
      pkg("closed"),
      pkg("bare"),
    ];
    const rows = await coverage(cfg, installed);
    const state = Object.fromEntries(rows.map((r) => [r.name, r.state]));
    assert.deepEqual(state, {
      bare: "unmapped",
      closed: "none",
      down: "unchecked",
      empty: "no-notes",
      good: "mapped",
      paged: "mapped",
      prerel: "mapped",
      tagsonly: "no-notes",
    });
    const out = renderCoverage(rows);
    assert.match(out, /^3 of 8 installed packages/m);
    assert.match(out, /could not check \(1\)\n {2}down/);
    assert.match(out, /^unmapped \(1\)\n {2}bare/m);
    // Without a forge call, the overview's count sees a source as enough.
    assert.equal(unmappedCount(cfg, installed), 1);
  } finally {
    restore();
  }
});
