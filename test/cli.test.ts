// SPDX-License-Identifier: GPL-3.0-or-later
// The CLI as a process: what it writes, and what it exits with.
//
// Everything else in this suite calls exported functions, which means main()
// — where every exit code is decided — was never once executed by a test. An
// exit code is the only part of a CLI that a scheduler reads, so a wrong one
// is silent by construction: cron sees success and says nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

const runtimeDirs: string[] = [];
after(async () => {
  await Promise.all(runtimeDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A PATH with the launcher's own dependencies on it and nothing else. */
async function hermeticBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bumpii-rt-"));
  runtimeDirs.push(dir);
  // bin/bumpii is POSIX sh: it resolves its own path through dirname, then
  // execs node. grep is for the commands that search the user's files.
  await symlink(process.execPath, join(dir, "node"));
  await symlink("/usr/bin/dirname", join(dir, "dirname"));
  await symlink("/usr/bin/grep", join(dir, "grep"));
  return dir;
}

/** A fake brew answering the two questions the scan commands ask it. */
async function stubBrewPath(opts: { leaves?: string[]; formulae?: unknown[] }): Promise<string> {
  const dir = await hermeticBin();
  const p = join(dir, "brew");
  // printf rather than a here-document: sh writes one to a temp file, which a
  // sandboxed test run is not always allowed to create — and the failure comes
  // back as "brew info failed", which reads as a bug in the code under test.
  const json = JSON.stringify({ formulae: opts.formulae ?? [] });
  await writeFile(
    p,
    `#!/bin/sh\ncase "$1 $2" in\n` +
      `  "leaves ") printf '%s\\n' ${(opts.leaves ?? []).map((l) => `'${l}'`).join(" ") || "''"} ;;\n` +
      `  *) printf '%s' '${json}' ;;\n` +
      `esac\n`,
  );
  await chmod(p, 0o755);
  return dir;
}

/** A receipt as brew reports it, dated relative to now so windows are stable. */
const receipt = (name: string, daysAgo: number, onRequest = true) => ({
  name,
  installed: [
    {
      version: "1.0.0",
      time: Math.floor(Date.now() / 1000) - daysAgo * 86_400,
      installed_on_request: onRequest,
    },
  ],
});

/**
 * A PATH holding nothing but what the launcher needs, plus — when `ps` is
 * given — a fake podman answering it.
 *
 * Hermetic on purpose. Prepending the fixture to the real PATH would work for
 * the stubbed cases but not for the one that asserts NO runtime is found: a
 * machine or CI runner with docker in /usr/bin would answer there, and the
 * test would mean something different depending on where it ran.
 */
async function runtimePath(ps?: string): Promise<string> {
  const dir = await hermeticBin();
  if (ps !== undefined) {
    const p = join(dir, "podman");
    await writeFile(
      p,
      `#!/bin/sh\ncase "$1" in\n  --version) echo "podman version 5.2.0"; exit 0 ;;\n  ps) ${ps}; exit 0 ;;\nesac\nexit 1\n`,
    );
    await chmod(p, 0o755);
  }
  return dir;
}

/** The entry `add --image` writes for a container, in the shape scan matches on. */
const containerTool = (name: string) => ({
  name,
  source: "github:o/r",
  version: {
    cmd: ["podman", "inspect", "--format", "{{.Config.Image}}", name],
    match: ":v?([0-9][0-9.]*)",
  },
  update: "true",
});

test("scan --image lists the running containers that have no entry", async () => {
  const home = await freshHome();
  await writeConfig(home, [containerTool("grafana")]);
  const dir = await runtimePath(`printf 'grafana\\tgrafana:11.4.0\\n'; printf 'pg\\tpostgres:17-alpine\\n'`);
  const r = await runCli(["scan", "--image"], home, { PATH: dir });

  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 running container\(s\) not tracked \(podman\)/);
  assert.match(r.stdout, /^\s+pg\s+postgres:17-alpine$/m, "the image is shown, so it can be recognised");
  assert.doesNotMatch(r.stdout, /grafana/, "the tracked one must not be offered again");
  assert.match(r.stdout, /bumpii add --image pg/, "and the command that would add it");
});

test("scan --image matches on the container the entry inspects, not just its key", async () => {
  // The config key is whatever `add --image` was given, and an entry renamed by
  // hand still probes the real container. Matching on the key alone would keep
  // offering a container that is already tracked.
  const home = await freshHome();
  const renamed = { ...containerTool("pg"), name: "database" };
  await writeConfig(home, [renamed]);
  const dir = await runtimePath(`printf 'pg\\tpostgres:17-alpine\\n'`);
  const r = await runCli(["scan", "--image"], home, { PATH: dir });

  assert.equal(r.code, 0);
  assert.match(r.stdout, /every running container is already tracked/);
});

test("scan --image separates nothing running from everything tracked", async () => {
  const home = await freshHome();
  await writeConfig(home, [containerTool("grafana")]);
  const dir = await runtimePath("true");
  const r = await runCli(["scan", "--image"], home, { PATH: dir });

  assert.equal(r.code, 0);
  // "everything tracked" against an empty runtime would read as a confirmation
  // that the config covers the machine, which is the opposite of what it means.
  assert.match(r.stdout, /no containers are running \(podman\)/);
});

test("scan --image without a runtime says which ones it looked for", async () => {
  const home = await freshHome();
  await writeConfig(home, [containerTool("grafana")]);
  const r = await runCli(["scan", "--image"], home, { PATH: await runtimePath() });

  assert.equal(r.code, 2);
  assert.match(r.stderr, /neither podman nor docker is on PATH/);
});

test("scan --new separates what you asked for from what came in behind it", async () => {
  // The live case that shaped this: one `brew install php@8.1` put 77 formulae
  // in the window, 76 of them dependencies. Listing all of them buries the one
  // line that answers the question.
  const home = await freshHome();
  await writeConfig(home, [tool({ source: "github:o/r" })]);
  const dir = await stubBrewPath({
    formulae: [
      receipt("php@8.1", 1),
      receipt("libpng", 1, false),
      receipt("krb5", 2, false),
      receipt("gh", 400),
    ],
  });
  const r = await runCli(["scan", "--new"], home, { PATH: dir });

  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 formula\(e\) you asked for/);
  assert.match(r.stdout, /php@8\.1/);
  assert.doesNotMatch(r.stdout, /libpng/, "a dependency is counted, not listed");
  assert.match(r.stdout, /2 dependencies came in behind them — --deps/);
  assert.doesNotMatch(r.stdout, /\bgh\b\s+1\.0\.0/, "and nothing outside the window");
  // The claim the receipts can actually support, said rather than implied.
  assert.match(r.stdout, /an upgrade is indistinguishable from a\nfirst install/);
  assert.match(r.stdout, /bumpii add php@8\.1/);
});

test("scan --deps lists the dependencies and says why each row is there", async () => {
  const home = await freshHome();
  await writeConfig(home, [tool({ source: "github:o/r" })]);
  const dir = await stubBrewPath({ formulae: [receipt("php@8.1", 1), receipt("libpng", 1, false)] });
  const r = await runCli(["scan", "--new", "--deps"], home, { PATH: dir });

  assert.equal(r.code, 0);
  assert.match(r.stdout, /libpng\s+1\.0\.0\s+\d{4}-\d{2}-\d{2}\s+dependency/);
  assert.match(r.stdout, /php@8\.1\s+1\.0\.0\s+\d{4}-\d{2}-\d{2}\s+requested/);
});

test("scan --new honours the window instead of reporting everything", async () => {
  const home = await freshHome();
  await writeConfig(home, [tool({ source: "github:o/r" })]);
  const dir = await stubBrewPath({ formulae: [receipt("recent", 3), receipt("older", 40)] });

  const narrow = await runCli(["scan", "--new", "--since", "7d"], home, { PATH: dir });
  assert.match(narrow.stdout, /recent/);
  assert.doesNotMatch(narrow.stdout, /older/);

  const wide = await runCli(["scan", "--new", "--since", "9w"], home, { PATH: dir });
  assert.match(wide.stdout, /older/, "9w is 63 days, which reaches the 40-day-old install");
});

test("scan --new with an empty window says so instead of printing a bare heading", async () => {
  const home = await freshHome();
  await writeConfig(home, [tool({ source: "github:o/r" })]);
  const dir = await stubBrewPath({ formulae: [receipt("gh", 400)] });
  const r = await runCli(["scan", "--new"], home, { PATH: dir });

  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing installed in the last 14 days/);
  assert.match(r.stdout, /--since/, "and how to look further back");
});

test("scan --unref names the leaves no file of yours mentions", async () => {
  const home = await freshHome();
  const files = await mkdtemp(join(tmpdir(), "bumpii-files-"));
  await writeFile(join(files, "backup.sh"), "#!/bin/sh\nrestic backup /data\n");
  await writeConfig(home, [tool({ source: "github:o/r" })], [files]);
  const dir = await stubBrewPath({
    leaves: ["restic", "mpv", "libpng"],
    formulae: [receipt("restic", 5), receipt("mpv", 5), receipt("libpng", 5, false)],
  });
  const r = await runCli(["scan", "--unref"], home, { PATH: dir });

  assert.equal(r.code, 0);
  assert.match(r.stdout, /2 of 3 leaves are named in nothing you wrote/);
  assert.match(r.stdout, /mpv\s+requested/);
  assert.match(
    r.stdout,
    /libpng\s+dependency/,
    "a leaf nothing depends on any more is the strongest candidate",
  );
  assert.doesNotMatch(r.stdout, /^\s+restic/m, "a formula the scripts call is not unreferenced");
  // The claim is bounded on purpose — this is the command that could most
  // easily be read as "you never use it".
  assert.match(r.stdout, /this is not "you never use it"/);
  assert.match(r.stdout, /searched: /, "and which paths that verdict rests on");
});

test("scan --unref refuses to answer when there is nowhere to search", async () => {
  // With no usagePaths every formula comes back unreferenced — a full page of
  // confident wrong answers, and the failure mode this command must not have.
  const home = await freshHome();
  await writeConfig(home, [tool({ source: "github:o/r" })], []);
  const dir = await stubBrewPath({ leaves: ["mpv"], formulae: [receipt("mpv", 5)] });
  const r = await runCli(["scan", "--unref"], home, { PATH: dir });

  assert.equal(r.code, 2);
  assert.match(r.stderr, /nothing to search/);
  assert.doesNotMatch(r.stdout, /mpv/);
});

test("scan --unref says which configured paths were missing, not just that none worked", async () => {
  const home = await freshHome();
  await writeConfig(home, [tool({ source: "github:o/r" })], ["/nope/not/here"]);
  const dir = await stubBrewPath({ leaves: ["mpv"], formulae: [receipt("mpv", 5)] });
  const r = await runCli(["scan", "--unref"], home, { PATH: dir });

  assert.equal(r.code, 2);
  assert.match(r.stderr, /\/nope\/not\/here/);
});

test("scan takes one mode at a time rather than printing two reports at once", async () => {
  const home = await freshHome();
  await writeConfig(home, [tool({ source: "github:o/r" })]);
  const r = await runCli(["scan", "--new", "--unref"], home, { PATH: await hermeticBin() });

  assert.equal(r.code, 2);
  assert.match(r.stderr, /one of --image, --new or --unref/);
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

test("a manual update line is complete — list counts only the comment as a gap", async () => {
  const home = await freshHome();
  await writeConfig(home, [
    tool({ name: "auto", source: "github:o/r", update: "manual: open the app's updater" }),
    tool({ name: "draft", source: "github:o/r", update: "# complete this: pull and restart" }),
  ]);
  const r = await runCli(["list"], home);
  assert.match(r.stdout, /draft.*needs: update/);
  assert.doesNotMatch(r.stdout, /auto.*needs/);
  assert.match(r.stdout, /1 entry incomplete/);
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

test("--yes skips a manual entry as routine, not as a failure", async (t) => {
  // A manual entry is complete — there is simply no command to run — so a
  // scheduled `--yes` must not exit red over it the way it does for an
  // unfinished placeholder (which `sh -c` would "run" successfully).
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url, update: "manual: use the in-app updater" })]);

  const r = await runCli(["--yes", "--no-judge"], home);
  assert.match(r.stdout, /manual: use the in-app updater — skipped/);
  assert.equal(r.code, 0, "nothing failed — a manual entry is not a broken one");
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
