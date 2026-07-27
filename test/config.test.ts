// SPDX-License-Identifier: GPL-3.0-or-later
// The config is a file the README invites you to hand-edit, and `bumpii add`
// rewrites it. That combination is where a tool quietly destroys work.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addTools, loadConfig } from "../src/config.ts";
import type { ToolConfig } from "../src/types.ts";

const gh: ToolConfig = {
  name: "gh",
  source: "github:cli/cli",
  version: { cmd: ["gh", "--version"], match: "gh version ([0-9][0-9.]*)" },
  update: "brew upgrade gh",
};
const jq: ToolConfig = {
  name: "jq",
  source: "github:jqlang/jq",
  version: { cmd: ["jq", "--version"], match: "jq-([0-9][0-9.]*)" },
  update: "brew upgrade jq",
};

let dir: string | null = null;

async function configFile(contents: unknown): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), "bumpii-config-"));
  const p = join(dir, `tools-${Math.abs(JSON.stringify(contents).length)}.json`);
  await writeFile(p, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
  return p;
}

test.after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("add preserves fields it does not know about", async () => {
  // Rebuilding the file from the fields this version happens to understand
  // deletes a $schema line, or a setting a newer release added, without a word.
  const p = await configFile({
    $schema: "https://example.com/bumpii.json",
    notifyCommand: "terminal-notifier -message",
    usagePaths: ["~/ops/scripts"],
    tools: [gh],
  });

  assert.deepEqual(await addTools([jq], p), ["jq"]);

  const after = JSON.parse(await readFile(p, "utf8"));
  assert.equal(after.$schema, "https://example.com/bumpii.json");
  assert.equal(after.notifyCommand, "terminal-notifier -message");
  assert.deepEqual(after.usagePaths, ["~/ops/scripts"]);
  assert.deepEqual(
    after.tools.map((t: ToolConfig) => t.name),
    ["gh", "jq"],
  );
});

test("add never replaces a tool you tuned by hand", async () => {
  const tuned = { ...gh, update: "brew upgrade --fetch-HEAD gh" };
  const p = await configFile({ usagePaths: [], tools: [tuned] });

  assert.deepEqual(await addTools([gh], p), [], "an existing name is skipped, not overwritten");
  const after = JSON.parse(await readFile(p, "utf8"));
  assert.equal(after.tools[0].update, "brew upgrade --fetch-HEAD gh");
});

test("a broken version.match is caught at load, naming the field", async () => {
  // Otherwise it surfaces per tool, mid-run, as a bare "Invalid regular
  // expression" that never says which entry produced it.
  const p = await configFile({
    tools: [{ ...gh, version: { cmd: ["gh", "--version"], match: "gh version ([0-9" } }],
  });
  await assert.rejects(loadConfig(p), /tools\[0\]\.version\.match is not a valid regex/);
});

test("a usagePaths that is not a list is rejected, not silently emptied", async () => {
  // Coercing it to [] would make every usage verdict "none", and the next
  // `add` would write that emptiness back over what the user typed.
  const p = await configFile({ usagePaths: "~/ops/scripts", tools: [gh] });
  await assert.rejects(loadConfig(p), /usagePaths` must be an array/);
});

test("a config that is not JSON says so instead of throwing a parser error", async () => {
  const p = await configFile('{ "tools": [ }');
  await assert.rejects(loadConfig(p), /is not valid JSON/);
});

test("a missing config points at the command that creates one", async () => {
  await assert.rejects(loadConfig(join(tmpdir(), "bumpii-absent", "tools.json")), /run: bumpii init/);
});

test("loadConfig defaults usagePaths but keeps the rest verbatim", async () => {
  const p = await configFile({ tools: [gh] });
  const cfg = await loadConfig(p);
  assert.deepEqual(cfg.usagePaths, []);
  assert.deepEqual(cfg.tools, [gh]);
});
