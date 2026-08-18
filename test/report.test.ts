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
  hits: [],
  ...over,
});

const rel = (version: string): Release => ({
  tag: `v${version}`,
  version,
  publishedAt: null,
  notes: "",
  url: `https://example.com/${version}`,
});

test("an entry with no source is shown as waiting for one, not as an error", () => {
  // `add --image` writes these when an image does not name its repo. It is one
  // line from working, so an error colour would overstate it — and silence
  // would let it sit there unnoticed forever.
  const out = renderReport([report({ tool: { ...tool, source: "" }, installed: null, latest: null })], {
    engine,
    missingPaths: [],
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
  const out = renderReport([pending], { engine: noEngine, missingPaths: [] });
  assert.match(out, /41 commits behind on tip/);
  assert.doesNotMatch(out, /1 release behind/);

  const current = report({
    installed: "aaa111222",
    latest: "aaa111222",
    channel: { tag: "tip", aheadBy: 0 },
  });
  const outCurrent = renderReport([current], { engine: noEngine, missingPaths: [] });
  assert.match(outCurrent, /up to date on tip/);
});

test("a forge with no comparable release is reported unknown, never up to date", () => {
  // A repo that only tags, or only publishes rolling pointers, gives bumpii
  // nothing it can order. Calling that "up to date" is the one wrong answer an
  // update checker must not give.
  const out = renderReport([report({ latest: null })], { engine, missingPaths: [] });
  assert.match(out, /unknown/);
  assert.doesNotMatch(out, /up to date/);
  assert.match(out, /publishes no versioned releases/, "the reason has to be actionable");
});

test("up to date is still said when there is something to compare against", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    missingPaths: [],
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
    missingPaths: [],
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
    { engine, missingPaths: [] },
  );
  assert.match(out, /up to date on tip/);
  assert.doesNotMatch(out, /ahead of/);
});

test("a failed digest keeps the releases and names the failure", () => {
  // The engine dying must cost the summary, not the news.
  const out = renderReport(
    [report({ behind: [rel("2.96.0")], digestError: "no JSON array in engine output" })],
    { engine, missingPaths: [] },
  );
  assert.match(out, /1 release behind/);
  assert.match(out, /digest failed: no JSON array/);
  assert.match(out, /https:\/\/example\.com\/2\.96\.0/, "raw notes URL is the fallback");
  assert.match(out, /brew upgrade gh/, "the update command must survive too");
});

test("no engine and a silent engine are not described the same way", () => {
  const withoutEngine = renderReport([report({ behind: [rel("2.96.0")] })], {
    engine: noEngine,
    missingPaths: [],
  });
  assert.match(withoutEngine, /no engine reachable/);

  const silent = renderReport([report({ behind: [rel("2.96.0")] })], { engine, missingPaths: [] });
  assert.match(silent, /returned nothing usable/);
  assert.doesNotMatch(silent, /no engine/, "blaming a working engine sends you to fix the wrong thing");
});

test("an engine you turned off yourself is not reported as unavailable", () => {
  // --no-judge is a choice, and "no engine available" reads as a broken setup.
  const skipped: Engine = { kind: "none", model: "", label: "skipped (--no-judge)" };
  const out = renderReport([report({ behind: [rel("2.96.0")] })], {
    engine: skipped,
    missingPaths: [],
  });
  assert.match(out, /no digest — skipped \(--no-judge\)/);
  assert.doesNotMatch(out, /unavailable|not reachable/);
});

test("a count the page cut short is marked, not reported as exact", () => {
  const behind = [rel("2.94.0"), rel("2.95.0"), rel("2.96.0")];
  assert.match(
    renderReport([report({ behind, truncated: true })], { engine, missingPaths: [] }),
    /3\+ releases behind/,
  );
  assert.match(
    renderReport([report({ behind })], { engine, missingPaths: [] }),
    /3 releases behind/,
    "an exact count must not grow a plus",
  );
});

test("an empty usagePaths config is called out, apart from paths that do not exist", () => {
  // With nothing configured there is nothing "missing", so the existing
  // warning never fires — and every "affects you: none" above would be a
  // statement about an empty search presented as one about the user's files.
  const out = renderReport([report()], { engine, missingPaths: [], noUsagePaths: true });
  assert.match(out, /no usagePaths configured/);
  assert.doesNotMatch(out, /usagePaths not found/);
  const configured = renderReport([report()], { engine, missingPaths: [] });
  assert.doesNotMatch(configured, /no usagePaths configured/);
});

test("a missing usage path is called out, not swallowed", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    missingPaths: ["~/ops/scripts"],
  });
  assert.match(out, /usagePaths not found: ~\/ops\/scripts/);
  assert.match(out, /incomplete/, "it has to say what that does to the verdict");
});

test("affects you counts changes, not grep hits", () => {
  const out = renderReport(
    [
      report({
        behind: [rel("2.96.0")],
        items: [
          { kind: "feature", summary: "a", commands: ["gh pr view --json"], version: "2.96.0" },
          { kind: "fix", summary: "b", commands: ["gh attestation verify"], version: "2.96.0" },
        ],
        // Three references to the same command are one affected change.
        hits: [
          { command: "gh pr view --json", file: "/a.sh", line: 1 },
          { command: "gh pr view --json", file: "/b.sh", line: 4 },
          { command: "gh pr view --json", file: "/c.sh", line: 9 },
        ],
      }),
    ],
    { engine, missingPaths: [] },
  );
  assert.match(out, /affects you: 1 of 2 changes/);
});

test("parseItems digs the array out of whatever the model wrapped it in", () => {
  // Small local models fence their JSON and chat around it often enough that
  // stripping is cheaper than re-prompting.
  const items = parseItems(
    'Sure! Here you go:\n```json\n[{"kind":"security","summary":"CVE fixed","commands":["gh pr view"],"version":"2.96.0"}]\n```\nHope that helps.',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "security");
  assert.deepEqual(items[0]?.commands, ["gh pr view"]);
});

test("parseItems repairs what it can and drops what it cannot", () => {
  const items = parseItems(
    '[{"kind":"nonsense","summary":"x"},{"summary":"   "},{"kind":"fix","summary":"y","commands":["a",7]}]',
  );
  assert.deepEqual(
    items.map((i) => i.kind),
    ["fix", "fix"],
    "an unknown kind falls back to fix rather than sinking the item",
  );
  assert.equal(items.length, 2, "an item with no summary carries no information");
  assert.deepEqual(items[1]?.commands, ["a"], "non-string commands are dropped, not stringified");
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
    missingPaths: [],
  });
  assert.match(out, /not installed/);
  assert.match(out, /publishes no versioned releases/);
  assert.doesNotMatch(out, /latest \?/);
});

test("other brew-pending packages are named, with a way to see them", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    missingPaths: [],
    otherPending: 3,
  });
  assert.match(out, /3 other packages have brew updates pending/);
  assert.match(out, /bumpii overview/);
});

test("one other pending package is not reported as three", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    missingPaths: [],
    otherPending: 1,
  });
  assert.match(out, /1 other package has brew updates pending/);
});

test("a failed or skipped brew check says nothing, rather than claiming zero", () => {
  // undefined is "not checked"; printing "0 other packages" would claim a
  // clean sweep the tool never verified.
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    missingPaths: [],
  });
  assert.doesNotMatch(out, /other package/);
});

test("a missing usage path says what to do about it, like every other state", () => {
  const out = renderReport([report({ installed: "2.96.0", latest: "2.96.0" })], {
    engine,
    missingPaths: ["~/ops/scripts"],
  });
  assert.match(out, /correct it in usagePaths, or remove it/);
});
