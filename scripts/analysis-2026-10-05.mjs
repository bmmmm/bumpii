// SPDX-License-Identifier: GPL-3.0-or-later
// Opt-in regression probes for docs/IMPROVEMENT_PLAN.md, not the default suite.
// These assert desired behaviour and fail on the analyzed baseline.
// Run: node --test scripts/analysis-2026-10-05.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/exec.ts";
import { digest } from "../src/judge.ts";
import { brewSources, resolveSources } from "../src/outdated.ts";
import { buildOverview } from "../src/overview.ts";
import { renderOverview, renderReport } from "../src/render.ts";

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

test("F1: a tracked self-updating cask must not also be current", async (t) => {
  await sandbox(t, {
    greedy: { formulae: [], casks: [packageRow("selfy", "1.0.0", "2.0.0")] },
    versions: "selfy 1.0.0\n",
  });
  const got = await buildOverview({ usagePaths: [], tools: [tool("selfy")] }, { engine, concurrency: 1 });
  assert.equal(got.selfUpdating.length, 1, "the pending cask must actually be observed");
  t.diagnostic(JSON.stringify({ current: got.current, selfUpdating: got.selfUpdating }));
  t.diagnostic(renderOverview(got));
  assert.equal(got.current.length, 0, "a measured pending cask was also called current");
});

for (const [name, installed, latest, outside] of [
  ["app", "1.0.0", "1.1.0", "1.2.0"],
  ["app@1", "1.0.0", "1.1.0", "2.0.0"],
]) {
  test(`F2: overview release range for ${name} stops at brew's target`, async (t) => {
    const env = await sandbox(t, {
      outdated: { formulae: [packageRow(name, installed, latest)], casks: [] },
    });
    const usage = join(env.dir, "usage.txt");
    await writeFile(usage, `${name}\n`);
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return Response.json(
        [outside, latest, installed].map((v) => ({
          tag_name: `v${v}`,
          body: "A user-visible change.",
          html_url: `https://example.invalid/v${v}`,
        })),
      );
    };
    const got = await buildOverview({ usagePaths: [usage], tools: [tool(name)] }, { engine, concurrency: 1 });
    assert.equal(got.entries.length, 1);
    assert.equal(got.entries[0].refs, 1, "the forge path must run, not the no-signal shortcut");
    assert.equal(fetches, 1);
    const entry = got.entries[0];
    t.diagnostic(
      JSON.stringify({
        name,
        installed: entry.installed,
        latest: entry.latest,
        behind: entry.behind.map((r) => r.version),
      }),
    );
    assert.deepEqual(
      entry.behind.map((r) => r.version),
      [latest],
      "notes exceed the displayed upgrade range",
    );
  });
}

test("F3: a transient source lookup failure is retried after recovery", async (t) => {
  const env = await sandbox(t, { infoFails: true });
  const path = join(env.dir, "sources.json");
  const failed = await resolveSources(["app"], path);
  await env.save({ info: { formulae: [{ name: "app", homepage: source }], casks: [] } });
  assert.equal((await brewSources(["app"])).app, source, "brew must actually have recovered");
  const callsBeforeRetry = (await env.calls()).length;
  const recovered = await resolveSources(["app"], path);
  const calls = await env.calls();
  assert.ok(calls.length > 0);
  t.diagnostic(
    JSON.stringify({
      failed,
      recovered,
      callsBeforeRetry,
      calls,
      disk: JSON.parse(await readFile(path, "utf8")),
    }),
  );
  assert.equal(recovered.app, source, "cached unknown still hides a source after brew recovered");
});

test("F4: a digest must disclose notes omitted from model input", async (t) => {
  await sandbox(t);
  const marker = "SECURITY_CHANGE_AT_END";
  const releases = [release("2.0.0", `${"A".repeat(60_001)}\n${marker}`)];
  let sent = "";
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body).messages[0].content;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify([{ kind: "feature", summary: "Add a command", version: "2.0.0" }]),
          },
        },
      ],
    });
  };
  const items = await digest(model, "app", releases);
  assert.ok(sent.length > 60_000);
  assert.equal(sent.includes(marker), false, "the sentinel must actually be outside the input");
  const report = renderReport(
    [
      {
        tool: tool(),
        installed: "1.0.0",
        latest: "2.0.0",
        behind: releases,
        items,
        truncated: false,
      },
    ],
    { engine: model },
  );
  t.diagnostic(
    JSON.stringify({
      noteCharacters: releases[0].notes.length,
      promptCharacters: sent.length,
      sentinelSeen: sent.includes(marker),
      report,
    }),
  );
  assert.match(report, /truncat|partial|incomplete|omitted/i, "the reader cannot see that input was omitted");
});

test("F5: malformed model items must not become a cached empty success", async (t) => {
  await sandbox(t);
  let calls = 0;
  const releases = [release("2.0.0", "Security fix: reject unsafe input.")];
  globalThis.fetch = async () => {
    calls++;
    const content =
      calls === 1
        ? '[{"kind":"security","summary":42,"version":"2.0.0"}]'
        : '[{"kind":"security","summary":"Reject unsafe input","version":"2.0.0"}]';
    return Response.json({ choices: [{ message: { content } }] });
  };
  let first;
  let error;
  try {
    first = await digest(model, "app", releases);
  } catch (err) {
    error = err;
  }
  const second = await digest(model, "app", releases);
  const report = renderReport(
    [
      {
        tool: tool(),
        installed: "1.0.0",
        latest: "2.0.0",
        behind: releases,
        items: second,
      },
    ],
    { engine: model },
  );
  t.diagnostic(JSON.stringify({ first, error: error?.message, second, calls, report }));
  assert.ok(error instanceof Error, "an invalid nonempty answer was accepted as no items");
  assert.equal(calls, 2, "invalid output must not prevent the retry");
  assert.equal(second.length, 1);
});

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

test("F7: a digest with a pending tool and a failed tool exits 2", async (t) => {
  const env = await sandbox(t);
  const tools = [tool("pending"), { ...tool("broken"), source: `${source}-broken` }];
  await writeFile(join(env.dir, "bumpii", "tools.json"), JSON.stringify({ tools, usagePaths: [] }));
  const hook = join(env.dir, "fetch.mjs");
  await writeFile(
    hook,
    `globalThis.fetch = async (url) => String(url).includes('app-broken')
    ? new Response('unavailable', {status: 503})
    : Response.json([{tag_name: 'v2.0.0', body: 'Change', html_url: 'https://example.invalid/v2.0.0'}]);`,
  );
  let result;
  try {
    const out = await run(
      process.execPath,
      ["--import", hook, fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "digest", "--no-judge"],
      { env: process.env, timeout: 10_000 },
    );
    result = { ...out, code: 0 };
  } catch (err) {
    result = err;
  }
  assert.match(result.stdout, /1 release behind/);
  assert.match(result.stdout, /broken\s+error/);
  t.diagnostic(JSON.stringify({ code: result.code, stdout: result.stdout, stderr: result.stderr }));
  assert.equal(result.code, 2, "a known fetch failure is hidden by the updates-available exit code");
});
