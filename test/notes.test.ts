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

const {
  answered,
  coverage,
  coverageNames,
  fetchPage,
  hasNotes,
  PAGE_CAP,
  pageText,
  pageVersion,
  pickReleases,
  readNotes,
  resolveTarget,
  unmappedCount,
  versionSection,
} = await import("../src/notes.ts");
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
    // A real Response, so the body is a stream like the one fetchPage reads.
    return new Response(status === 204 ? null : text, {
      status,
      statusText: status === 200 ? "OK" : "Server Error",
      headers: { "content-type": hit.type ?? "application/json" },
    });
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
  requested: true,
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
    "https://x.org/NEWS": { body: "Noteworthy changes in release 6.1\n<not a tag>", type: "text/plain" },
    "https://x.org/r.html": { body: "<p>a</p><p>b</p>", type: "text/html; charset=utf-8" },
    "https://x.org/gone": { status: 500, body: "" },
  });
  try {
    assert.equal(
      (await fetchPage("https://x.org/NEWS")).text,
      "Noteworthy changes in release 6.1\n<not a tag>",
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
    const r = await readNotes(t, { last: 1 });
    assert.deepEqual(
      r.releases.map((x) => x.tag),
      ["lang-8.1.34"],
    );
  } finally {
    restore();
  }
});

test("a package from a prerelease channel reads its prereleases, marked; others stay stable-only", async () => {
  // brew installs `editor@preview` from the prerelease line, so stable-only
  // notes were older than the build installed.
  const restore = stubFetch({
    "https://git.example.com/api/v1/repos/o/editor/releases?limit=30": {
      body: [
        { tag_name: "v2.0.0-pre", body: "pre notes", prerelease: true },
        { tag_name: "v1.9.0", body: "stable notes" },
      ],
    },
  });
  try {
    const cfg = config({ packages: { "editor@preview": { source: "https://git.example.com/o/editor" } } });
    const r = await readNotes(resolveTarget("editor@preview", cfg, [pkg("editor@preview")]), { last: 1 });
    assert.equal(r.releases[0]?.tag, "v2.0.0-pre");
    assert.match(renderNotes(r), /^v2\.0\.0-pre {2}prerelease /m);
    const plain = await readNotes(
      resolveTarget(
        "editor",
        config({ packages: { editor: { source: "https://git.example.com/o/editor" } } }),
        [],
      ),
      { last: 1 },
    );
    assert.equal(plain.releases[0]?.tag, "v1.9.0");
    assert.doesNotMatch(renderNotes(plain), /prerelease/);
  } finally {
    restore();
  }
});

test("pageText stays linear on pages that never close what they open", () => {
  // Measured on the regex version: 2 MiB of an unclosed <script> took 73 s,
  // `<nav x>` repeated 101 s, and nothing could interrupt it.
  const MB2 = 2 * 1024 * 1024;
  for (const [what, html] of [
    ["unclosed script", `<p>notes</p><script>${"var a=1;".repeat(MB2 / 8)}`],
    ["repeated <nav x>", "<nav x>".repeat(MB2 / 7)],
    ["< with no >", "a<b ".repeat(MB2 / 4)],
    ["<x with no >", "<x".repeat(MB2 / 2)],
    ["unclosed comment", `<p>a</p><!--${"x".repeat(MB2)}`],
  ] as const) {
    const t0 = performance.now();
    pageText(html);
    assert.ok(performance.now() - t0 < 1000, `${what} took ${Math.round(performance.now() - t0)} ms`);
  }
  // What the page left open goes, and does not leak in as notes.
  assert.equal(pageText(`<p>notes</p><script>${"var a=1;".repeat(100)}`), "notes");
});

test("a header inside the article keeps its title; page chrome outside it still goes", () => {
  const html =
    "<header><nav>Home</nav></header><article><header><h1>Release 3.2.1</h1></header><p>Fixes.</p></article>" +
    "<footer>legal</footer>";
  assert.equal(pageText(html), "Release 3.2.1\n\nFixes.");
  assert.equal(pageText("<p>1 < 2 and 3 > 2</p>"), "1 < 2 and 3 > 2");
  assert.equal(
    pageText('<!DOCTYPE html><?xml version="1.0"?><html><body><p>notes</p></body></html>'),
    "notes",
  );
});

test("a changelog is cut to the installed version's section, ending where the page starts the next", () => {
  const changelog = [
    "Changelog",
    "",
    "- Tool 4.441 [2026-08-06]",
    "- fixed a regression since 4.43",
    "- fixed b",
    "",
    "- Tool 4.44 [2026-03-26]",
    "- older",
  ].join("\n");
  assert.deepEqual(versionSection(changelog, "4.441"), {
    // A version named inside an entry is not the next entry: only a line
    // shaped like the one that opened the section ends it.
    text: "- Tool 4.441 [2026-08-06]\n- fixed a regression since 4.43\n- fixed b",
    matched: "4.441",
    from: 3,
    to: 5,
    total: 8,
  });
  // The prefix's digits are blurred, so a date in it does not end the match.
  const datey = ["- 3/14/2025 version 2.2.0", "  new codec", "- 9/2/2024 version 2.1.0", "  older"].join(
    "\n",
  );
  assert.equal(versionSection(datey, "2.2.0")?.text, "- 3/14/2025 version 2.2.0\n  new codec");
  // A NEWS file names the release, brew installs a patch level of it.
  const news = [
    "Noteworthy changes in release 6.1",
    "a. thing",
    "",
    "Noteworthy changes in release 6.0",
    "b.",
  ].join("\n");
  assert.equal(versionSection(news, "6.1.12")?.matched, "6.1");
  assert.equal(versionSection(news, "6.1.12")?.text, "Noteworthy changes in release 6.1\na. thing");
  // 4.44 is not 4.441, and 2.2 is not a prefix match against 2.20.
  assert.equal(versionSection(changelog, "4.44")?.from, 7);
  assert.equal(versionSection("version 2.20 only", "2.2"), null);
  assert.equal(versionSection(changelog, "9.9"), null);
});

test("a table of contents naming the version is skipped for the section further down", () => {
  // Changelogs open with a list of every release; its line for the version
  // matches first and ends at the next list entry — one line, no notes.
  const page = [
    "- Tool 3.2.1 [date]",
    "- Tool 3.2.0 [date]",
    "",
    "- Tool 3.2.1 [date]",
    "fixed a",
    "fixed b",
    "- Tool 3.2.0 [date]",
  ].join("\n");
  assert.equal(versionSection(page, "3.2.1")?.text, "- Tool 3.2.1 [date]\nfixed a\nfixed b");
  // A mention inside an entry never meets a line shaped like itself, and
  // would run to the end of the page; the heading further down is taken.
  const mention = [
    "- Tool 3.2.1 [date]",
    "- Tool 3.2.0 [date]",
    "",
    "Tool 3.2.2 [date]",
    "- fixed a crash in Tool 3.2.1.",
    "",
    "Tool 3.2.1 [date]",
    "fixed b",
    "Tool 3.2.0 [date]",
    "older",
  ].join("\n");
  assert.equal(versionSection(mention, "3.2.1")?.text, "Tool 3.2.1 [date]\nfixed b");
  // The last entry on a page has no next one to end it: still the section,
  // not the table-of-contents line above it.
  const last = ["- Tool 3.2.1", "- Tool 3.2.0", "", "Tool 3.2.1", "fixed"].join("\n");
  assert.equal(versionSection(last, "3.2.1")?.text, "Tool 3.2.1\nfixed");
  // Nothing but the list: the list line is still better than nothing.
  assert.equal(versionSection("- Tool 3.2.1\n- Tool 3.2.0", "3.2.1")?.text, "- Tool 3.2.1");
});

test("a letter brew appends is tried off before a component is, and a shorter match is said", () => {
  // brew installs 2.4.7b, the page names v2.4.7; falling back to 2.4 first
  // printed an older release's notes.
  const page = ["Tool v2.4.7", "newest", "", "Tool v2.4", "older"].join("\n");
  assert.equal(versionSection(page, "2.4.7b")?.matched, "2.4.7");
  assert.equal(versionSection(page, "2.4.7b")?.text, "Tool v2.4.7\nnewest");
  // The letter-less version is the installed release itself, not a guess, so
  // it may stand as the page's last entry with nothing after it to close it.
  assert.equal(versionSection("Intro\nTool v2.4.7\nnewest", "2.4.7b")?.text, "Tool v2.4.7\nnewest");
});

test("notes shows the section with its place on the page, --full the rest, and says why when it cannot cut", async () => {
  const page = ["Changes", "", "== 3.2.1 ==", "fixed", "", "== 3.2.0 ==", "older"].join("\n");
  const restore = stubFetch({ "https://x.example/notes": { body: page, type: "text/plain" } });
  try {
    const cfg = config({ packages: { app: { page: "https://x.example/notes" } } });
    const t = resolveTarget("app", cfg, [pkg("app")]);
    const cut = await readNotes(t, { last: 1 });
    assert.equal(cut.pageText, "== 3.2.1 ==\nfixed");
    const out = renderNotes(cut);
    assert.match(out, /the section for 3\.2\.1, lines 3–4 of 7/);
    assert.match(out, /5 more lines on the page — --full for all of it/);
    assert.doesNotMatch(out, /itself is not named/);
    assert.equal((await readNotes(t, { last: 1, full: true })).pageText, page);
    // A page named after the version is that release already: not cut again.
    const versioned = config({ packages: { app: { page: "https://x.example/notes?v={version}" } } });
    const restorePage = stubFetch({ "https://x.example/notes?v=3.2.1": { body: page, type: "text/plain" } });
    try {
      const whole = await readNotes(resolveTarget("app", versioned, [pkg("app")]), { last: 1 });
      assert.equal(whole.pageText, page);
    } finally {
      restorePage();
    }
    const absent = await readNotes(resolveTarget("app", cfg, [pkg("app", { version: "4.0.0" })]), {
      last: 1,
    });
    assert.equal(absent.pageText, page);
    assert.match(renderNotes(absent), /brew's newest version is not named in it, so all 7 lines/);
    const patch = await readNotes(resolveTarget("app", cfg, [pkg("app", { version: "3.2.1.4" })]), {
      last: 1,
    });
    assert.match(
      renderNotes(patch),
      /the section for 3\.2\.1, lines 3–4 of 7 \(3\.2\.1\.4 itself is not named on it\)/,
    );
    const unknown = await readNotes(resolveTarget("app", cfg, [pkg("app", { version: null })]), { last: 1 });
    assert.match(renderNotes(unknown), /no version known to cut it to, so all 7 lines/);
  } finally {
    restore();
  }
});

test("a version with a letter or a -suffix after it is not that version", () => {
  // The compareVersions pair again: 3.5a follows 3.5, 2.0.0-rc1 precedes 2.0.0.
  const newestFirst = ["## 3.5a", "letter release", "", "## 3.5", "plain release", "", "## 3.4", "old"].join(
    "\n",
  );
  assert.equal(versionSection(newestFirst, "3.5")?.text, "## 3.5\nplain release");
  const oldestFirst = ["## 2.0.0-rc1", "candidate", "", "## 2.0.0", "final", "", "## 2.0.1", "next"].join(
    "\n",
  );
  assert.equal(versionSection(oldestFirst, "2.0.0")?.text, "## 2.0.0\nfinal");
  // A Debian changelog heads each entry `pkg (version-revision)`: the
  // revision is packaging, the release is the same.
  const debian = [
    "pkg (1.2.3-2ubuntu1) unstable; urgency=medium",
    "",
    "  * Fix a.",
    "",
    " -- Some One <one@example.org>  Mon, 01 Jun 2026 12:00:00 +0000",
    "",
    "pkg (1.2.2-1) unstable; urgency=medium",
    "",
    "  * Older.",
  ].join("\n");
  assert.equal(versionSection(debian, "1.2.3")?.to, 5);
  assert.equal(versionSection(debian, "1.2.3")?.matched, "1.2.3");
  // Several revisions of one release are one section: the upstream notes are
  // in the oldest revision, and ending at the next one showed only packaging.
  const revisions = [
    "pkg (1.2.3-2) unstable; urgency=medium",
    "  * Packaging fix.",
    "",
    "pkg (1.2.3-1) unstable; urgency=medium",
    "  * New upstream release.",
    "",
    "pkg (1.2.2-1) unstable; urgency=medium",
    "  * Older.",
  ].join("\n");
  assert.equal(versionSection(revisions, "1.2.3")?.to, 5);
  // Anywhere but a Debian heading a dash and a digit is another version: an
  // npm prerelease, a date-stamped snapshot.
  const npm = ["## 1.0.1-1", "pre one", "", "## 1.0.1", "final", "", "## 1.0.0", "old"].join("\n");
  assert.equal(versionSection(npm, "1.0.1")?.text, "## 1.0.1\nfinal");
  const snapshot = [
    "## v1.2.3-20260101",
    "snapshot",
    "",
    "## v1.2.3",
    "release",
    "",
    "## v1.2.2",
    "old",
  ].join("\n");
  assert.equal(versionSection(snapshot, "1.2.3")?.text, "## v1.2.3\nrelease");
  assert.equal(versionSection("pkg (1.2.3~rc1-1) unstable;\n  * rc\npkg (1.2.2-1) unstable;", "1.2.3"), null);
});

test("versionSection stays fast on a page made of hits that never close", () => {
  // Measured before the shapes were computed once: 28 s, event loop blocked.
  const hits = Array.from({ length: 50 }, (_, i) => `mention ${i} of 3.2.1 here`);
  const dense = Array.from({ length: 10_000 }, (_, i) => `x${"9.9.9 ".repeat(30)}${i}`.slice(0, 196));
  const t0 = performance.now();
  versionSection([...hits, ...dense].join("\n"), "3.2.1");
  assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`);
  // A page of identical headings of the version: each line's heading is
  // judged once, not once per hit.
  const same = Array.from({ length: 70_000 }, (_, i) => `## [3.2.1](https://x/compare/v3.2.0...v3.2.1) ${i}`);
  const t1 = performance.now();
  versionSection(same.join("\n"), "3.2.1");
  assert.ok(
    performance.now() - t1 < 1000,
    `identical headings took ${Math.round(performance.now() - t1)} ms`,
  );
});

test("a heading names its version first: a compare link naming the previous one is not its section", () => {
  const page = [
    "## [1.0.2](https://x.example/compare/v1.0.1...v1.0.2) (2026-02-01)",
    "- newer",
    "",
    "## [1.0.1](https://x.example/compare/v1.0.0...v1.0.1) (2026-01-01)",
    "- the installed one",
    "",
    "## [1.0.0](https://x.example/compare/v0.9.0...v1.0.0)",
    "- old",
  ].join("\n");
  assert.equal(
    versionSection(page, "1.0.1")?.text,
    "## [1.0.1](https://x.example/compare/v1.0.0...v1.0.1) (2026-01-01)\n- the installed one",
  );
});

test("a mention of the version in the next heading ends the section; dates and dotted names before it do not hide it", () => {
  // The next release mentioning this one is still the next release.
  const backport = ["## 1.2.3", "fixed", "", "## 1.2.2 (backport of the 1.2.3 fix)", "older"].join("\n");
  assert.equal(versionSection(backport, "1.2.3")?.text, "## 1.2.3\nfixed");
  const oldestFirst = ["## 1.0.0", "first", "", "## 1.0.1 - fixes a regression in 1.0.0", "second"].join(
    "\n",
  );
  assert.equal(versionSection(oldestFirst, "1.0.0")?.text, "## 1.0.0\nfirst");
  const linksOldestFirst = [
    "## [1.0.1](https://x.example/compare/v1.0.0...v1.0.1)",
    "- the installed one",
    "",
    "## [1.0.2](https://x.example/compare/v1.0.1...v1.0.2)",
    "- newer",
  ].join("\n");
  assert.equal(versionSection(linksOldestFirst, "1.0.1")?.to, 2);
  // Something version-shaped before the version is not a reason to skip it.
  const dated = ["14.03.2026 — Version 2.2.0", "notes", "", "02.01.2026 — Version 2.1.0", "older"].join("\n");
  assert.equal(versionSection(dated, "2.2.0")?.text, "14.03.2026 — Version 2.2.0\nnotes");
  const dottedName = [
    "tool9.9 (5.4.6-3) unstable; urgency=medium",
    "  * fix",
    "",
    "tool9.9 (5.4.6-2) unstable;",
    "  * older",
  ].join("\n");
  assert.equal(versionSection(dottedName, "5.4.6")?.to, 5);
});

test("tag-prefixed links, inline ranges and from→to headings are references; a bare path heading is not", () => {
  const entries = (h2: string, h1: string, h0: string) =>
    [h2, "- newer", "", h1, "- the installed one", "", h0, "- old"].join("\n");
  // Monorepo compare links carry the package in the tag.
  const monorepo = entries(
    "## [1.0.2](https://x.example/compare/pkg-v1.0.1...pkg-v1.0.2)",
    "## [1.0.1](https://x.example/compare/pkg-v1.0.0...pkg-v1.0.1)",
    "## [1.0.0](https://x.example/compare/pkg-v0.9.0...pkg-v1.0.0)",
  );
  assert.equal(versionSection(monorepo, "1.0.1")?.from, 4);
  const at = entries(
    "## 1.0.2 (https://x.example/compare/pkg@1.0.1...pkg@1.0.2)",
    "## 1.0.1 (https://x.example/compare/pkg@1.0.0...pkg@1.0.1)",
    "## 1.0.0",
  );
  assert.equal(versionSection(at, "1.0.1")?.from, 4);
  const inline = entries("## 1.0.2 (v1.0.1..v1.0.2)", "## 1.0.1 (v1.0.0..v1.0.1)", "## 1.0.0");
  assert.equal(versionSection(inline, "1.0.1")?.text, "## 1.0.1 (v1.0.0..v1.0.1)\n- the installed one");
  // A from→to heading is the later release's entry.
  const between = entries(
    "### Changes between 3.0.15 and 3.0.16 [1 Jan 2026]",
    "### Changes between 3.0.14 and 3.0.15 [1 Oct 2025]",
    "### Changes between 3.0.13 and 3.0.14 [1 Jul 2025]",
  );
  assert.equal(versionSection(between, "3.0.15")?.from, 4);
  assert.equal(versionSection(between, "3.0.15")?.to, 5);
  assert.equal(versionSection(between, "3.0.16")?.from, 1);
  // A link with no range in it is a reference too.
  const linked = entries(
    "## 1.0.2 (previous: https://x.example/releases/tag/v1.0.1)",
    "## 1.0.1 (previous: https://x.example/releases/tag/v1.0.0)",
    "## 1.0.0",
  );
  assert.equal(versionSection(linked, "1.0.1")?.from, 4);
  // A range heading is the entry of the release it runs to.
  const ranges = entries("## v1.0.1..v1.0.2", "## v1.0.0..v1.0.1", "## v0.9.0..v1.0.0");
  assert.equal(versionSection(ranges, "1.0.1")?.text, "## v1.0.0..v1.0.1\n- the installed one");
  // The same with the product named on both sides, and with an arrow.
  const named = entries(
    "## Changes between Tool 3.0.15 and Tool 3.0.16",
    "## Changes between Tool 3.0.14 and Tool 3.0.15",
    "## Changes between Tool 3.0.13 and Tool 3.0.14",
  );
  assert.equal(versionSection(named, "3.0.15")?.from, 4);
  const arrows = entries("## 1.0.1 → 1.0.2", "## 1.0.0 → 1.0.1", "## 0.9.0 → 1.0.0");
  assert.equal(versionSection(arrows, "1.0.1")?.text, "## 1.0.0 → 1.0.1\n- the installed one");
  // Two releases named together are both that entry's, not a transition.
  const joint = ["## 3.5.1 and 3.5.2 (security)", "- both", "", "## 3.5.0", "- older"].join("\n");
  assert.equal(versionSection(joint, "3.5.1")?.text, "## 3.5.1 and 3.5.2 (security)\n- both");
  const batch = ["## 1.0.1 to 1.0.3", "- batch", "", "## 1.0.0", "- older"].join("\n");
  assert.equal(versionSection(batch, "1.0.1")?.text, "## 1.0.1 to 1.0.3\n- batch");
  // A reference earlier on the line does not hide the heading's own version.
  const refFirst = [
    "## (see https://x.example/v1.0.1) 1.0.1",
    "- notes",
    "",
    "## (see https://x.example/v1.0.0) 1.0.0",
    "- old",
  ].join("\n");
  assert.equal(versionSection(refFirst, "1.0.1")?.text, "## (see https://x.example/v1.0.1) 1.0.1\n- notes");
  // A path without a scheme or a range is the heading itself.
  const path = entries("## releases/1.0.2", "## releases/1.0.1", "## releases/1.0.0");
  assert.equal(versionSection(path, "1.0.1")?.text, "## releases/1.0.1\n- the installed one");
});

test("a shorter version is only trusted with a section the page closes", () => {
  // "requires 3.12 now" in some entry is not the section for 3.12.1.
  const page = ["## 4.0.0", "- requires Tool 3.12 now", "- more", "- and more"].join("\n");
  assert.equal(versionSection(page, "3.12.1"), null);
});

test("a <main> written in a script or template is not the page's content; an unclosed head ends at the body", () => {
  assert.equal(
    pageText("<script>var t='<main>x</main>'</script><body><h2>1.2.3</h2><p>notes</p></body>"),
    "1.2.3\nnotes",
  );
  assert.equal(pageText("<template><article>t</article></template><p>notes</p>"), "notes");
  assert.equal(pageText("<html><head><title>t</title><body><p>notes</p></body></html>"), "notes");
  // A self-closing <svg/> holds nothing; read as open, it took the page with it.
  assert.equal(
    pageText("<main><h2>1.2.3</h2><p>a</p><svg class=icon /><h2>1.2.2</h2><p>b</p></main>"),
    "1.2.3\na\n\n1.2.2\nb",
  );
  assert.equal(pageText("<script src=x /><p>notes</p>"), "notes");
  // A form wrapping the whole body (one framework does this on every page) is not chrome.
  assert.equal(pageText("<body><form><p>notes</p></form></body>"), "notes");
});

test("an acknowledged none beside a source that only tags is the answer, said, and exit 0", async () => {
  const restore = stubFetch({
    "https://git.example.com/api/v1/repos/o/x/releases?limit=30": {
      body: [{ tag_name: "v1.2.3", body: "" }],
    },
  });
  try {
    const cfg = config({ packages: { x: { none: "tags only, no changelog" } } });
    const r = await readNotes(
      resolveTarget("x", cfg, [pkg("x", { derived: "https://git.example.com/o/x" })]),
      { last: 1 },
    );
    assert.equal(answered(r), true);
    assert.match(renderNotes(r), /no release notes published: tags only, no changelog/);
  } finally {
    restore();
  }
});

test("a none beside a read that failed is shown as the user's note, not as this run's answer", async () => {
  const restore = stubFetch({});
  try {
    const cfg = config({ packages: { x: { none: "tags only" } } });
    const r = await readNotes(
      resolveTarget("x", cfg, [pkg("x", { derived: "https://git.example.com/o/x" })]),
      { last: 1 },
    );
    assert.equal(answered(r), false);
    const out = renderNotes(r);
    assert.match(out, /could not read its releases/);
    assert.match(out, /set as publishing no notes: tags only — not confirmed: a read above failed/);
    assert.doesNotMatch(out, /no release notes published/);
    // The same for a page that could not be read.
    const paged = config({ packages: { y: { none: "nothing", page: "https://down.example/notes" } } });
    const p = await readNotes(resolveTarget("y", paged, [pkg("y")]), { last: 1 });
    assert.match(renderNotes(p), /could not read the page[\s\S]*not confirmed: a read above failed/);
  } finally {
    restore();
  }
});

test("the hidden-line count includes what is above the section, and wording follows what was read", () => {
  const base = {
    name: "app",
    source: null,
    page: "https://x.example/n",
    pageUnfilled: false,
    pageVersioned: false,
    version: "3.2.1",
    key: "app",
    none: null,
    releases: [],
    releasesError: null,
    branch: null,
    channel: null,
    pageText: "## 3.2.1\nfixed",
    pageTruncated: false,
    pageError: null,
  };
  const mid = renderNotes({
    ...base,
    pageScope: { kind: "section", matched: "3.2.1", installed: "3.2.1", from: 40, to: 60, total: 100 },
  });
  assert.match(mid, /79 more lines on the page/);
  const atEnd = renderNotes({
    ...base,
    pageScope: { kind: "section", matched: "3.2.1", installed: "3.2.1", from: 40, to: 100, total: 100 },
  });
  assert.match(atEnd, /39 more lines on the page/);
  const cut = renderNotes({
    ...base,
    pageTruncated: true,
    pageScope: { kind: "all", reason: "not-found", total: 9 },
  });
  assert.match(cut, /not named in the part read/);
  const pre = renderNotes({
    ...base,
    source: "github:o/r",
    page: null,
    pageText: null,
    pageScope: null,
    channel: "preview",
  });
  assert.match(pre, /the forge lists no release among its newest/);
  assert.doesNotMatch(pre, /stable/);
});

test("scan lists a none beside an unfillable page as acknowledged, as the overview count does", async () => {
  const cfg = config({
    packages: { app: { page: "https://x.example/app-{version}.html", none: "nothing yet" } },
  });
  const installed = [pkg("app", { version: null })];
  assert.deepEqual(
    (await coverage(cfg, installed)).map((r) => r.state),
    ["none"],
  );
  assert.equal(unmappedCount(cfg, installed), 0);
});

test("a page that is not text is refused, and one that does not end is read only to the cap", async () => {
  const big = "x".repeat(PAGE_CAP + 10);
  const restore = stubFetch({
    "https://x.example/doc.pdf": { body: "%PDF-1.7 binary", type: "application/pdf" },
    "https://x.example/big": { body: big, type: "text/plain" },
  });
  try {
    await assert.rejects(
      fetchPage("https://x.example/doc.pdf"),
      /not a text page — https:\/\/x\.example\/doc\.pdf answered application\/pdf/,
    );
    const r = await fetchPage("https://x.example/big");
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, PAGE_CAP);
  } finally {
    restore();
  }
});

test("an acknowledged none answers the question; a failure does not", () => {
  const base = {
    name: "app",
    source: null,
    page: null,
    pageUnfilled: false,
    pageVersioned: false,
    version: null,
    key: "app",
    releases: [],
    releasesError: null,
    branch: null,
    channel: null,
    pageText: null,
    pageScope: null,
    pageTruncated: false,
    pageError: null,
  };
  assert.equal(answered({ ...base, none: "publishes nothing" }), true);
  assert.equal(answered({ ...base, none: null }), false);
  // A none beside a source that failed is no answer: the source was asked.
  assert.equal(answered({ ...base, none: "x", source: "github:o/r", releasesError: "500" }), false);
});

test("suggestions stay near: a short name is not a substring match for every typo", () => {
  const cfg = config({
    tools: [
      {
        name: "gh",
        source: "github:cli/cli",
        version: { cmd: ["gh"], match: "(.)" },
        update: "brew upgrade gh",
      },
    ],
  });
  const installed = [pkg("ghostwriter"), pkg("ghostwriter-ish"), pkg("netscope-app")];
  assert.throws(
    () => resolveTarget("ghosty", cfg, installed),
    (e: Error) => !/"gh"/.test(e.message),
  );
  assert.throws(() => resolveTarget("netscope", cfg, installed), /did you mean "netscope-app"\?/);
});

test("a dependency answers notes, but scan and the overview count leave it out", async () => {
  const cfg = config({
    tools: [
      { name: "npmtool", source: "", version: { cmd: ["x"], match: "(.)" }, update: "npm i -g npmtool" },
    ],
  });
  const installed = [
    pkg("libdep", { kind: "formula", requested: false, derived: "https://git.example.com/o/libdep" }),
    pkg("asked"),
  ];
  assert.equal(resolveTarget("libdep", cfg, installed).source, "https://git.example.com/o/libdep");
  // The tracked tool brew did not install counts too, in both places alike.
  assert.deepEqual(coverageNames(cfg, installed), ["asked", "npmtool"]);
  assert.equal(unmappedCount(cfg, installed), 2);
  const rows = await coverage(cfg, installed);
  assert.deepEqual(
    rows.map((r) => `${r.name}:${r.state}`),
    ["asked:unmapped", "npmtool:unmapped"],
  );
});

test("a {version} page brew has no version for is a gap in scan, not mapped", async () => {
  const cfg = config({ packages: { app: { page: "https://x.example/app-{version}.html" } } });
  const rows = await coverage(cfg, [pkg("app", { version: null })]);
  assert.deepEqual(
    rows.map((r) => r.state),
    ["no-notes"],
  );
  assert.equal(unmappedCount(cfg, [pkg("app", { version: null })]), 1);
  assert.equal(pageVersion("3.2.1,b7"), "3.2.1");
  assert.equal(pageVersion("latest"), null);
});

test("a page needing a version brew does not know is shown unfilled and never fetched", async () => {
  const cfg = config({ packages: { app: { page: "https://x.org/app-{version}.html" } } });
  const t = resolveTarget("app", cfg, [pkg("app", { version: null })]);
  assert.equal(t.pageUnfilled, true);
  const restore = stubFetch({});
  try {
    const r = await readNotes(t, { last: 1 });
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
    const r = await readNotes(resolveTarget("pixbench", cfg, [pkg("pixbench")]), { last: 1 });
    assert.equal(hasNotes(r), true);
    const out = renderNotes(r);
    assert.match(out, /PIXBENCH_3_2_6 published no notes/);
    assert.match(out, /text extracted from that page[^\n]*:\n\nPixbench 3\.2\.6\nbug fixes/);
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
    const r = await readNotes(resolveTarget("app", cfg, []), { last: 1 });
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
    const r = await readNotes(resolveTarget("app", cfg, []), { last: 1 });
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
    pageVersioned: false,
    version: null,
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
    pageScope: null,
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
