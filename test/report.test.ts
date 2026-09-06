// SPDX-License-Identifier: GPL-3.0-or-later
// What the report is allowed to claim. Two of these guard against a confident
// wrong answer rather than a crash: "up to date" for a repo that was never
// comparable, and a usage verdict computed over paths nobody searched.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Engine } from "../src/judge.ts";
import { parseItems } from "../src/judge.ts";
import { renderReport } from "../src/render.ts";
import type { Release, ToolConfig, ToolReport } from "../src/types.ts";

const engine: Engine = { kind: "openai", model: "local", label: "openai-compatible/local" };
const noEngine: Engine = { kind: "none", model: "", label: "none (no engine reachable)" };

const tool: ToolConfig = {
  name: "gh",
  source: "github:cli/cli",
  version: { cmd: ["gh", "--version"], match: "gh version ([0-9][0-9.]*)" },
  update: "brew upgrade gh",
};

const report = (over: Partial<ToolReport> = {}): ToolReport => ({
  tool,
  installed: "2.90.0",
  latest: "2.96.0",
  behind: [],
  items: [],
  ...over,
});

// Notes default to empty because that is what a plain tag carries, but a test
// about what the engine did with them has to hand it something to read — an
// empty body never reaches the engine at all.
const rel = (version: string, notes = ""): Release => ({
  tag: `v${version}`,
  version,
  publishedAt: null,
  notes,
  url: `https://example.com/${version}`,
});

test("an entry with no source is shown as waiting for one, not as an error", () => {
  // `add --image` writes these when an image does not name its repo. It is one
  // line from working, so an error colour would overstate it — and silence
  // would let it sit there unnoticed forever.
  const out = renderReport([report({ tool: { ...tool, source: "" }, installed: null, latest: null })], {
    engine,
  });
  assert.match(out, /needs a source/);
  assert.match(out, /nothing is being watched until then/);
  assert.doesNotMatch(out, /error/);
  assert.doesNotMatch(out, /up to date/);
});

test("a channel entry counts commits, and a current one names its channel", () => {
  // The synthetic release is one entry however far the gap is — "1 release
  // behind" would be technically true and completely misleading. And a bare
  // commit hash marked "up to date" looks like a rendering slip unless the
  // channel it is current on is named.
  const pending = report({
    installed: "aaa111222",
    latest: "999fff000",
    channel: { tag: "tip", aheadBy: 41 },
    behind: [{ tag: "tip", version: "999fff000", publishedAt: null, notes: "sha subject", url: "https://x" }],
  });
  const out = renderReport([pending], { engine: noEngine });
  assert.match(out, /41 commits behind on tip/);
  assert.doesNotMatch(out, /1 release behind/);

  const current = report({
    installed: "aaa111222",
    latest: "aaa111222",
    channel: { tag: "tip", aheadBy: 0 },
  });
  const outCurrent = renderReport([current], { engine: noEngine });
  assert.match(outCurrent, /up to date: gh aaa111222 on tip/);
});

test("a forge with no comparable release is reported unknown, never up to date", () => {
  // A repo that only tags, or only publishes rolling pointers, gives bumpii
  // nothing it can order. Calling that "up to date" is the one wrong answer an
  // update checker must not give.
  const out = renderReport([report({ latest: null })], { engine });
  assert.match(out, /unknown/);
  assert.doesNotMatch(out, /up to date/);
  assert.match(out, /publishes no versioned releases/, "the reason has to be actionable");
});

test("up to date is still said when there is something to compare against", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
  });
  assert.match(out, /up to date/);
});

test("a version above every release is named, not painted green", () => {
  // `version.match` runs over the binary's whole output, so a pattern without
  // a line anchor can capture a number that is not the version — a build date,
  // a library version, a port. Whatever it captures then outranks every
  // published release, nothing is ever "behind", and the tool reports itself
  // current forever. Green is the one colour that must not cover that.
  const out = renderReport([report({ installed: "20240101", latest: "2.96.0" })], {
    engine,
  });
  assert.doesNotMatch(out, /up to date/);
  assert.match(out, /ahead of 2\.96\.0/);
  assert.match(out, /version\.match/, "the reason has to point at the field that produced it");
});

test("a channel entry is never read as ahead of its own head", () => {
  // A channel's `latest` is a commit hash, so comparing it as a version is
  // meaningless — and hashes being unordered, roughly half of them would come
  // out "ahead" and lose their green.
  const out = renderReport(
    [
      report({
        installed: "fff999888",
        latest: "aaa111222",
        channel: { tag: "tip", aheadBy: 0 },
        behind: [],
      }),
    ],
    { engine },
  );
  assert.match(out, /up to date: gh fff999888 on tip/);
  assert.doesNotMatch(out, /ahead of/);
});

test("everything current shares one line, below the entries that need reading", () => {
  // Eleven tools that need nothing were twenty-two lines, with the one entry
  // worth reading somewhere between them.
  const current = (name: string, v: string) => report({ tool: { ...tool, name }, installed: v, latest: v });
  const out = renderReport(
    [
      current("bat", "0.26.1"),
      report({
        tool: { ...tool, name: "uv" },
        installed: "0.12.9",
        latest: "0.12.10",
        behind: [rel("0.12.10")],
      }),
      current("jq", "1.8.2"),
      report({
        tool: { ...tool, name: "ghostty" },
        installed: "492300cad",
        latest: "492300cad",
        channel: { tag: "tip", aheadBy: 0 },
      }),
    ],
    { engine },
  );
  assert.equal(out.match(/up to date/g)?.length, 1, `one line for all of them:\n${out}`);
  assert.match(
    out,
    /up to date: bat 0\.26\.1 · jq 1\.8\.2 · ghostty 492300cad on tip/,
    "config order, channel named",
  );
  assert.ok(out.indexOf("1 release behind") < out.indexOf("up to date:"), "the entry to read comes first");
  // Not painted green by association: a tool above every release stays its own line.
  const ahead = renderReport([report({ installed: "9.0.0", latest: "2.96.0" }), current("jq", "1.8.2")], {
    engine,
  });
  assert.match(ahead, /ahead of 2\.96\.0/);
  assert.doesNotMatch(ahead, /up to date:.*gh/);
});

test("no report claims to know which changes touch you", () => {
  const out = renderReport(
    [
      report({
        installed: "2.90.0",
        latest: "2.96.0",
        behind: [rel("2.96.0", "notes")],
        items: [{ kind: "security", summary: "CVE fixed", version: "2.96.0" }],
      }),
    ],
    { engine },
  );
  assert.match(out, /! security/, "the classification is what survived");
  assert.doesNotMatch(out, /affects you|you use this|mentions commands/);
});

test("a failed digest keeps the releases and names the failure", () => {
  // The engine dying must cost the summary, not the news.
  const out = renderReport(
    [report({ behind: [rel("2.96.0")], digestError: "no JSON array in engine output" })],
    { engine },
  );
  assert.match(out, /1 release behind/);
  assert.match(out, /digest failed: no JSON array/);
  assert.match(out, /https:\/\/example\.com\/2\.96\.0/, "raw notes URL is the fallback");
  assert.match(out, /brew upgrade gh/, "the update command must survive too");
});

test("no engine and a silent engine are not described the same way", () => {
  // Both releases carry notes on purpose: an empty body never reaches the
  // engine, so asserting the silent-engine string over one would pin the
  // wrong case — which is what this test did until the case below existed.
  const readable = [rel("2.96.0", "Fixed `gh pr view --json`")];
  const withoutEngine = renderReport([report({ behind: readable })], {
    engine: noEngine,
  });
  assert.match(withoutEngine, /no engine reachable/);

  const silent = renderReport([report({ behind: readable })], { engine });
  assert.match(silent, /read these notes and returned no items/);
  // An empty answer is not a broken engine: the prompt tells the model to skip
  // the project's own dependency bumps, so a release that is only those has
  // nothing left to report. The line names both possibilities and picks
  // neither, because the code cannot tell them apart.
  assert.match(silent, /or it is all dependency bumps/);
  assert.doesNotMatch(silent, /no engine/, "blaming a working engine sends you to fix the wrong thing");
  assert.doesNotMatch(silent, /failed/, "an answer with no items in it is not a failure");
});

test("a release the forge published without notes is not the engine's fault", () => {
  // htop tags every version and writes nothing, so the whole prompt would be
  // the line "### htop 3.5.3" — which is why judge.ts drops empty bodies
  // before building it. The engine is therefore never asked, and saying it
  // "returned nothing usable" sends the reader to check a model that did the
  // only thing it could. overview.ts has said so since the case was found;
  // digest and inbox kept the older wording.
  const out = renderReport([report({ behind: [rel("3.5.3")] })], { engine });
  assert.match(out, /published this release without notes/);
  assert.match(out, /nothing to read beyond the version number/);
  assert.doesNotMatch(out, /read these notes and returned no items/);
  assert.doesNotMatch(out, /digest failed/);
  // The release is still real and still pending, so its link has to survive.
  assert.match(out, /https:\/\/example\.com\/3\.5\.3/);
  assert.match(out, /1 release behind/);
});

test("an engine that did fail outranks the notes being empty", () => {
  // The two silences make different claims, and an error that happened is the
  // more specific one: swallowing it would be the same wrong answer in reverse.
  const out = renderReport(
    [report({ behind: [rel("3.5.3")], digestError: "no JSON array in engine output" })],
    { engine },
  );
  assert.match(out, /digest failed: no JSON array/);
  assert.doesNotMatch(out, /published this release without notes/);
});

test("an engine you turned off yourself is not reported as unavailable", () => {
  // --no-judge is a choice, and "no engine available" reads as a broken setup.
  const skipped: Engine = { kind: "none", model: "", label: "skipped (--no-judge)" };
  const out = renderReport([report({ behind: [rel("2.96.0")] })], {
    engine: skipped,
  });
  assert.match(out, /no digest — skipped \(--no-judge\)/);
  assert.doesNotMatch(out, /unavailable|not reachable/);
});

test("a count the page cut short is marked, not reported as exact", () => {
  const behind = [rel("2.94.0"), rel("2.95.0"), rel("2.96.0")];
  assert.match(renderReport([report({ behind, truncated: true })], { engine }), /3\+ releases behind/);
  assert.match(
    renderReport([report({ behind })], { engine }),
    /3 releases behind/,
    "an exact count must not grow a plus",
  );
});

test("parseItems digs the array out of whatever the model wrapped it in", () => {
  // Small local models fence their JSON and chat around it often enough that
  // stripping is cheaper than re-prompting.
  const items = parseItems(
    'Sure! Here you go:\n```json\n[{"kind":"security","summary":"CVE fixed","version":"2.96.0"}]\n```\nHope that helps.',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "security");
  assert.equal(items[0]?.version, "2.96.0");
});

test("parseItems repairs what it can and drops what it cannot", () => {
  const items = parseItems(
    '[{"kind":"nonsense","summary":"x"},{"summary":"   "},{"kind":"fix","summary":"y"}]',
  );
  assert.deepEqual(
    items.map((i) => i.kind),
    ["unclassified", "fix"],
    "an unknown kind keeps its item, but is not filed as one of the four",
  );
  // The item survives — that part was always right, and dropping it would lose
  // a change the notes did describe. What changed is where it lands: "fix" is
  // the mildest of the four and claimed a classification nothing performed.
  assert.equal(items[0]?.summary, "x", "the summary is what carries the change; it must not be lost");
  assert.equal(items.length, 2, "an item with no summary carries no information");
});

test("parseItems refuses output with no array rather than inventing one", () => {
  // This throw is what cli.ts isolates per tool: it costs the digest, not the
  // release list.
  assert.throws(() => parseItems("I could not find any release notes."), /no JSON array/);
  assert.throws(() => parseItems('{"kind":"fix"}'), /no JSON array/);
});

test("an entry that is neither installed nor comparable says both, not a bare ?", () => {
  // Two findings in one line: nothing here to run, and nothing at the source to
  // measure against. "latest ?" rendered that as a formatting slip.
  const out = renderReport([report({ installed: null, latest: null })], {
    engine,
  });
  assert.match(out, /not installed/);
  assert.match(out, /publishes no versioned releases/);
  assert.doesNotMatch(out, /latest \?/);
});

test("other brew-pending packages are counted and named, with a way to see them", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    otherPending: 3,
    otherPendingNames: ["docker", "rclone", "fish"],
  });
  // Names in brew's order, on the same line as the count they add up to.
  assert.match(out, /3 other packages have brew updates pending: docker, rclone, fish — bumpii overview/);
});

test("under --brew-upgrade the pending line says what happens next instead of advising it", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    otherPending: 2,
    otherPendingNames: ["docker", "rclone"],
    brewUpgrade: true,
  });
  assert.match(out, /2 other packages have brew updates pending: docker, rclone — brew upgrade runs next/);
  assert.doesNotMatch(out, /bumpii overview/, "advice to run what the run is about to run itself");
});

test("brew having nothing else pending is said, not left silent", () => {
  // A --brew-upgrade run's `brew upgrade` then prints nothing at all
  // (measured: env hints off, nothing pending, not one byte), and this line
  // is what makes that silence read as expected rather than as a failure.
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    otherPending: 0,
    otherPendingNames: [],
  });
  assert.match(out, /no other brew updates pending/);
  assert.doesNotMatch(out, /0 other/);
});

test("under --brew-upgrade an update line brew will not run is marked", () => {
  const claude = { ...tool, name: "claude", update: "claude update" };
  const manual = { ...tool, name: "ghostty", update: "manual: Ghostty updates itself" };
  const behind = { latest: "2.96.0", behind: [rel("2.96.0")] };
  const marked = renderReport(
    [report({ tool: claude, ...behind }), report(behind), report({ tool: manual, ...behind })],
    { engine, brewUpgrade: true },
  );
  assert.match(marked, /→ claude update\s+\(not run by brew upgrade\)/);
  assert.doesNotMatch(marked, /brew upgrade gh\s+\(not run/, "a brew line is exactly what brew upgrade runs");
  assert.doesNotMatch(
    marked,
    /Ghostty updates itself\s+\(not run/,
    "a manual line already says there is nothing to run",
  );
  // Without the flag the marker is meaningless, and absent.
  const plain = renderReport([report({ tool: claude, ...behind })], { engine });
  assert.doesNotMatch(plain, /not run by brew upgrade/);
});

test("one other pending package is not reported as three", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    otherPending: 1,
  });
  assert.match(out, /1 other package has brew updates pending/);
});

test("a failed or skipped brew check says nothing, rather than claiming zero", () => {
  // undefined is "not checked"; printing "0 other packages" would claim a
  // clean sweep the tool never verified.
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
  });
  assert.doesNotMatch(out, /other package/);
});

// Built from a named constant: an ESC byte inside a regex literal is a lint
// error here, and the assertions below have to talk about the byte itself.
const ESC = "\x1b";

test("a release note cannot drive the terminal it is printed into", () => {
  // Release notes and the judge's summary of them are written by whoever
  // publishes the release. Printed unescaped, `ESC[1A` and `ESC[2K` move the
  // cursor up and erase — which is enough to overwrite the report's own lines
  // and leave a forged "up to date" where a security item stood.
  //
  // Measured before the fix on the path with no model in it at all:
  // commandsFromNotes -> toNeedles -> mechanicalHits carried the bytes through
  // verbatim, so `--no-judge` was as exposed as a judged run.
  const evil = `${ESC}[2K${ESC}[1Agh 9.9.9  up to date`;
  const out = renderReport(
    [
      report({
        behind: [rel("2.96.0", "notes")],
        items: [{ kind: "security", summary: evil, version: "2.96.0" }],
      }),
    ],
    { engine },
  );
  assert.ok(!out.includes(`${ESC}[2K`), "an erase-line from a release note must not reach the terminal");
  assert.ok(!out.includes(`${ESC}[1A`), "nor a cursor move");
  // Stripped, not dropped: the reader still has to see what the note said.
  assert.match(out, /gh 9\.9\.9/);
});

test("a forge-supplied URL is not spliced into a terminal escape unchecked", () => {
  // link() wraps the release URL in OSC 8, and that URL is whatever the forge
  // put in html_url — a self-hosted one can put anything there. A javascript:
  // target or an embedded ESC has no business inside a control sequence.
  const bad = rel("2.96.0");
  bad.url = `javascript:alert(1)${ESC}]8;;`;
  const out = renderReport([report({ behind: [bad] })], { engine: noEngine });
  assert.ok(!out.includes(`${ESC}]8;;`), "no OSC 8 sequence may be built from that");
  assert.match(out, /javascript:alert\(1\)/, "the text is still shown, so nothing is hidden");
});
