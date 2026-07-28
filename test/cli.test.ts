// SPDX-License-Identifier: GPL-3.0-or-later
// The CLI as a process: what it writes, and what it exits with.
//
// Everything else in this suite calls exported functions, which means main()
// — where every exit code is decided — was never once executed by a test. An
// exit code is the only part of a CLI that a scheduler reads, so a wrong one
// is silent by construction: cron sees success and says nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/bumpii", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], home: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, args, {
      env: { ...process.env, XDG_CONFIG_HOME: home, NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      stdout += d;
    });
    p.stderr.on("data", (d) => {
      stderr += d;
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const freshHome = () => mkdtemp(join(tmpdir(), "bumpii-cli-"));

/**
 * Taken from what `init` reports rather than rebuilt here. Guessing it wrong
 * is not a visible failure: the CLI keeps reading the file init wrote, so
 * assertions pass against the shipped defaults instead of the fixture — which
 * is exactly what happened while writing these tests.
 */
async function initConfigPath(home: string): Promise<string> {
  const r = await runCli(["init"], home);
  const path = /^(?:wrote|already exists:) (.+)$/m.exec(r.stdout)?.[1];
  assert.ok(path, `init did not name the config it wrote: ${r.stdout}`);
  return path;
}

/** A tool whose version comes from `echo`, so no real binary has to exist. */
const tool = (over: Record<string, unknown> = {}) => ({
  name: "app",
  source: "",
  version: { cmd: ["echo", "app 1.0.0"], match: "app ([0-9.]+)" },
  update: "true",
  ...over,
});

/** Returns the config path, so every assertion reads the file the CLI reads. */
async function writeConfig(home: string, tools: unknown[], usagePaths: string[] = []): Promise<string> {
  const path = await initConfigPath(home);
  await writeFile(path, JSON.stringify({ usagePaths, tools }, null, 2));
  return path;
}

test("init writes a config, and saying so twice is not an error", async () => {
  const home = await freshHome();
  const first = await runCli(["init"], home);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /wrote /);

  const second = await runCli(["init"], home);
  assert.equal(second.code, 0, "re-running init must not look like a failure to a script");
  assert.match(second.stdout, /already exists/);
});

test("list names the gaps rather than only the entries", async () => {
  const home = await freshHome();
  await writeConfig(home, [tool(), tool({ name: "b", source: "github:o/r", update: "# finish me" })]);
  const r = await runCli(["list"], home);
  assert.equal(r.code, 0);
  // Both gaps, each named as the field it is — listing the entries without
  // saying which are unusable is what makes an unfinished one sit for months.
  assert.match(r.stdout, /^app\s+—\s+needs: source$/m);
  assert.match(r.stdout, /^b\s+github:o\/r\s+needs: update$/m);
  assert.match(r.stdout, /2 entries incomplete/);
  assert.match(r.stdout, /bumpii set/, "and how to close them");
});

test("rm on a name that is not tracked fails instead of reporting success", async () => {
  // The silent version of this is the dangerous one: a typo'd name in a
  // cleanup script would leave the entry in place and exit 0.
  const home = await freshHome();
  const path = await writeConfig(home, [tool({ source: "github:o/r" })]);
  const r = await runCli(["rm", "nosuch"], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /nosuch/);

  const left = JSON.parse(await readFile(path, "utf8"));
  assert.equal(left.tools.length, 1, "a failed rm must not have removed anything");
});

test("rm removes the named entry and leaves the rest of the document alone", async () => {
  const home = await freshHome();
  const path = await writeConfig(
    home,
    [tool({ source: "github:o/r" }), tool({ name: "b", source: "github:o/b" })],
    ["~/ops"],
  );
  const r = await runCli(["rm", "app"], home);
  assert.equal(r.code, 0);

  const left = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(
    left.tools.map((t: { name: string }) => t.name),
    ["b"],
  );
  assert.deepEqual(left.usagePaths, ["~/ops"], "the rest of the document has to survive an edit");
});

test("set writes a multi-word value as one value", async () => {
  const home = await freshHome();
  const path = await writeConfig(home, [tool({ source: "github:o/r" })]);
  const r = await runCli(["set", "app", "update", "podman", "pull", "app", "&&", "restart"], home);
  assert.equal(r.code, 0);

  const cfg = JSON.parse(await readFile(path, "utf8"));
  assert.equal(cfg.tools[0].update, "podman pull app && restart");
});

test("an unknown option exits 2 and names it, rather than running a default digest", async () => {
  const home = await freshHome();
  const r = await runCli(["--upgrade-everything"], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown option/);
});

test("running without a config points at init instead of a stack trace", async () => {
  const home = await freshHome();
  const r = await runCli([], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /bumpii init/);
  assert.doesNotMatch(r.stderr, /at .*\.ts:/, "an ENOENT trace is not an error message");
});

test("--only that matches nothing is an error, not an empty success", async () => {
  const home = await freshHome();
  await writeConfig(home, [tool({ source: "github:o/r" })]);
  const r = await runCli(["--only", "nosuch", "--no-judge"], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no tools matched/);
});

// ── against a stub forge ─────────────────────────────────────────────────────
// The exit codes that a scheduled run acts on can only be reached by actually
// contacting a forge. A loopback server is the whole dependency — no network
// leaves the machine — but binding a port is not always permitted, so these
// skip themselves rather than failing for a reason that has nothing to do with
// bumpii.

const servers: http.Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

async function stubForge(tags: string[]): Promise<string | null> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        // tag_name, as both forges send it. Sending `tag` instead made every
        // release parse as an empty version, so the report said "unknown" for
        // all three cases and one of them asserted that — a passing test
        // measuring nothing.
        tags.map((tag_name) => ({
          tag_name,
          prerelease: false,
          draft: false,
          body: "",
          html_url: `https://example.invalid/${tag_name}`,
        })),
      ),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch {
    return null; // sandboxes commonly refuse listen(); the caller skips
  }
  servers.push(server);
  const addr = server.address();
  return typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}/o/r` : null;
}

const SKIP = "cannot bind a loopback port in this environment";

test("a tool with nothing newer exits 0", async (t) => {
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url })]);

  const r = await runCli(["--no-judge"], home);
  assert.match(r.stdout, /up to date/);
  assert.equal(r.code, 0, "nothing pending is the only case a scheduler should read as quiet");
});

test("a pending release exits 1, which is what a scheduled run acts on", async (t) => {
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url })]);

  const r = await runCli(["--no-judge"], home);
  assert.match(r.stdout, /1 release behind/);
  assert.equal(r.code, 1);
});

test("a source with no comparable release exits 0 but never claims up to date", async (t) => {
  // Nothing is pending, so 0 is right — but the report must not say the tool
  // is current, because nothing was ever compared.
  const url = await stubForge(["nightly"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url })]);

  const r = await runCli(["--no-judge"], home);
  assert.match(r.stdout, /unknown/);
  assert.doesNotMatch(r.stdout, /up to date/);
  assert.equal(r.code, 0);
});

test("--yes exits 2 when an update command fails, not 0 for having tried", async (t) => {
  // The failure mode this guards: a nightly `bumpii --yes` reporting success
  // while the upgrade it ran errored out, so nothing is ever looked at again.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url, update: "exit 3" })]);

  const r = await runCli(["--yes", "--no-judge"], home);
  assert.equal(r.code, 2);
});
