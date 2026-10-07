// SPDX-License-Identifier: GPL-3.0-or-later
// Opt-in regression probes for docs/IMPROVEMENT_PLAN.md, not the default suite.
// These assert desired behaviour and fail on the analyzed baseline.
// Run: node --test scripts/analysis-2026-10-05.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOverview } from "../src/overview.ts";
import { renderOverview } from "../src/render.ts";

const engine = { kind: "none", model: "", label: "not asked for" };
const model = { kind: "openai", model: "audit-stub", label: "audit-stub", base: "https://engine.invalid/v1" };
const source = "https://git.example.invalid/o/app";
const release = (version, notes = "A user-visible change.") => ({
  tag: `v${version}`,
  version,
  notes,
  publishedAt: null,
  url: `https://example.invalid/releases/v${version}`,
});
const tool = (name = "app") => ({
  name,
  source,
  version: { cmd: ["/bin/echo", "app 1.0.0"], match: "^app ([0-9.]+)" },
  update: `brew upgrade ${name}`,
});
const packageRow = (name, installed, latest) => ({
  name,
  installed_versions: [installed],
  current_version: latest,
});

// Real brew subprocess boundary, deterministic local replies, no network.
const brewScript = `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.txt'), JSON.stringify(args) + '\\n');
if (args[0] === 'outdated') {
  console.log(JSON.stringify(args.includes('--greedy-auto-updates')
    ? state.greedy ?? state.outdated ?? {formulae: [], casks: []}
    : state.outdated ?? {formulae: [], casks: []}));
} else if (args[0] === 'info') {
  if (state.infoFails) { console.error('temporary metadata failure'); process.exit(1); }
  console.log(JSON.stringify(state.info ?? {formulae: [], casks: []}));
} else if (args[0] === 'list') {
  if (state.listFails) { console.error('temporary listing failure'); process.exit(1); }
  process.stdout.write(state.versions ?? '');
} else { throw new Error('Unexpected brew command: ' + args.join(' ')); }
`;

async function sandbox(t, state = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bumpii-analysis-"));
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  await writeFile(join(dir, "brew"), brewScript, { mode: 0o755 });
  const save = async (value) => writeFile(join(dir, "state.json"), JSON.stringify(value));
  await save(state);
  await writeFile(join(dir, "calls.txt"), "");
  await mkdir(join(dir, "bumpii"));
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  // Explicit local-only environment also prevents dotenv fallback or gh auth.
  process.env = {
    PATH: `${dir}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: dir,
    XDG_CACHE_HOME: dir,
    OPENAI_BASE_URL: model.base,
    OPENAI_API_KEY: "audit-placeholder",
    NO_COLOR: "1",
  };
  globalThis.fetch = async () => {
    throw new Error("Unexpected fetch in offline analysis");
  };
  t.after(async () => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    save,
    calls: async () => (await readFile(join(dir, "calls.txt"), "utf8")).trim().split("\n"),
  };
}

test("F6: a failed installed-version listing must not mean not installed", async (t) => {
  await sandbox(t, { listFails: true });
  const got = await buildOverview({ usagePaths: [], tools: [tool()] }, { engine, concurrency: 1 });
  assert.equal(got.unchecked.length, 1);
  t.diagnostic(JSON.stringify({ unchecked: got.unchecked, report: renderOverview(got) }));
  assert.notEqual(
    got.unchecked[0].reason,
    "not-installed",
    "the listing failed; absence was never established",
  );
});
