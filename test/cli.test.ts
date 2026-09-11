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

/** Start the CLI without waiting for it, for the tests that signal it. */
function spawnCli(args: string[], home: string, env: Record<string, string> = {}) {
  return spawn(BIN, args, {
    env: { ...process.env, XDG_CONFIG_HOME: home, NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A version probe that leaves evidence behind if it is allowed to finish.
 *
 * Asserting "the child is gone" needs something observable: pgrep is not
 * available everywhere and matching on process names picks up whatever else
 * the machine is running. A file the child creates only after sleeping is
 * checkable, hermetic, and says exactly what is being asked — did this
 * outlive the run that started it.
 */
const slowProbe = (marker: string, seconds = 4) => ({
  cmd: ["/bin/sh", "-c", `sleep ${seconds}; printf survived > ${marker}`],
  match: "([0-9.]+)",
});

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

/**
 * A fake brew that reports one outdated formula, for the overview command.
 *
 * `outdated --json=v2` and `info --json=v2 --installed` are the two it asks;
 * the second answers the "tracked, but is it installed" half of the report.
 */
async function stubBrewOutdated(pkg: { name: string; installed: string; latest: string }): Promise<string> {
  const dir = await hermeticBin();
  const outdated = JSON.stringify({
    formulae: [{ name: pkg.name, installed_versions: [pkg.installed], current_version: pkg.latest }],
    casks: [],
  });
  const info = JSON.stringify({
    formulae: [{ name: pkg.name, installed: [{ version: pkg.installed, installed_on_request: true }] }],
  });
  await writeFile(
    join(dir, "brew"),
    `#!/bin/sh\ncase "$1" in\n` +
      `  outdated) printf '%s' '${outdated}' ;;\n` +
      `  *) printf '%s' '${info}' ;;\n` +
      `esac\n`,
  );
  await chmod(join(dir, "brew"), 0o755);
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
  // Named explicitly: the bare invocation is help now, and help works fine
  // without a config — which would make this pass while proving nothing.
  const r = await runCli(["digest"], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /bumpii init/);
  assert.doesNotMatch(r.stderr, /at .*\.ts:/, "an ENOENT trace is not an error message");
});

test("the bare invocation prints help and touches nothing", async () => {
  const home = await freshHome();
  const r = await runCli([], home);
  assert.equal(r.code, 0, "help is not an error");
  assert.match(r.stdout, /bumpii digest/, "help has to name the command it replaced");
  // No config, and nothing complained: proof it never went looking for one.
  assert.equal(r.stderr, "");
});

test("digest refuses a positional instead of digesting everything", async () => {
  const home = await freshHome();
  const r = await runCli(["digest", "gh"], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--only gh/, "should point at the flag that means what was typed");
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

async function stubForge(tags: string[], body = ""): Promise<string | null> {
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
          body,
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

/** A forge that is reachable but broken, so listReleases fails per tool. */
async function stubForgeFailing(): Promise<string | null> {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("upstream is having a day");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch {
    return null;
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

test("a plain run asks no engine, and --no-judge is still accepted", async (t) => {
  // The default flipped: reading the notes is opted into, not out of. Proven
  // through the engine label, which only says this when args.judge is false —
  // resolveEngine would otherwise have probed OPENAI_BASE_URL or started a
  // `claude --version` subprocess before knowing whether anything is pending.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url })]);

  const plain = await runCli(["digest"], home);
  assert.match(plain.stdout, /engine: not asked for/);

  // Kept working on purpose: claudii's statusline refresh passes --no-judge
  // from a repo that does not ship with this one, so retiring the flag would
  // break the indicator rather than this tool.
  const legacy = await runCli(["digest", "--no-judge"], home);
  assert.equal(legacy.code, plain.code, "the old flag must not become an argument error");
  assert.match(legacy.stdout, /engine: not asked for/);
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
  // Not 2: nothing failed, a manual entry is not a broken one. Not 0 either:
  // the re-probe finds it on the same version, so it is still pending, and a
  // run that exits "nothing left" over a tool it could not touch is the
  // quiet wrong answer this tool exists to avoid.
  assert.match(r.stdout, /app: still 1\.0\.0 — its update line says there is nothing to run/);
  assert.equal(r.code, 1, "a manual entry is not a failure; it is still pending");
});

test("a run that could not reach anything must not exit 0", async (t) => {
  // Found by running the real digest with the network pulled out: twelve
  // tools, twelve "cannot reach api.github.com", and exit 0 — which is the
  // documented code for "nothing pending". A cron reading
  // `bumpii --json || notify` stays silent exactly when it has gone blind.
  const url = await stubForgeFailing();
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url })]);

  const r = await runCli(["digest", "--no-judge"], home);
  assert.match(r.stdout, /error/, "the report itself has to name the failure");
  assert.equal(r.code, 2, "0 would claim a check that never happened");
});

test("--yes on a run that could not reach anything must not exit 0 either", async (t) => {
  // The same blind run as above, one flag further along. updateFailures is only
  // ever incremented inside the update loop, and that loop's first statement
  // skips every report carrying an error — so nothing counts the failures and
  // the run reports success. Measured before the fix: identical config, exit 2
  // without --yes and exit 0 with it, over a report full of "error" lines.
  //
  // --yes is the unattended flag, so this is the exact shape that goes unseen:
  // the cron that upgrades nightly is the one with no human reading stdout.
  const url = await stubForgeFailing();
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url })]);

  const r = await runCli(["digest", "--yes", "--no-judge"], home);
  assert.match(r.stdout, /error/, "the report itself has to name the failure");
  assert.equal(r.code, 2, "--yes must not be a quieter exit code than the read-only run");
});

test("one broken tool among current ones still exits non-zero", async (t) => {
  // The mixed case: nothing is pending, one forge failed. "Nothing pending"
  // is only true of the eleven that answered.
  const ok = await stubForge(["v1.0.0"]);
  const broken = await stubForgeFailing();
  if (!ok || !broken) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: ok }), tool({ name: "other", source: broken })]);

  const r = await runCli(["digest", "--no-judge"], home);
  assert.match(r.stdout, /up to date/, "the tool that answered is still reported");
  assert.equal(r.code, 2);
});

test("overview keeps an unreachable package in the report rather than dropping it", async (t) => {
  // Why overview cannot make the mistake the digest made: every package brew
  // reports pending produces an entry, including the ones whose forge died —
  // so `entries.length` can only be zero when brew had nothing pending, which
  // is a genuine 0. Assert the invariant, not the reasoning: a later "skip the
  // unreachable ones" would turn a blind run back into a quiet exit 0.
  const broken = await stubForgeFailing();
  if (!broken) return t.skip(SKIP);
  const path = await stubBrewOutdated({ name: "uv", installed: "0.1.0", latest: "0.2.0" });
  const home = await freshHome();
  // The usagePath matters: with nothing naming `uv` its reference count is
  // zero, overview never contacts the forge at all, and the entry lands
  // fehlerfrei under "no signal" — which is how the first version of this test
  // stayed green with unreachable entries filtered out of the report.
  const usage = await freshHome();
  await writeFile(join(usage, "script.sh"), "#!/bin/sh\nuv sync\n");
  await writeConfig(home, [tool({ name: "uv", source: broken, update: "brew upgrade uv" })], [usage]);

  const r = await runCli(["overview", "--no-judge"], home, { PATH: path });
  assert.match(r.stdout, /uv/, "the package brew reported has to appear at all");
  assert.match(r.stdout, /(unreachable|error|could not)/i, "the failure has to be visible in the report");
  assert.equal(r.code, 1, "brew says something is pending — that is not a quiet run");
});

test("overview exits 2 when brew itself cannot answer", async () => {
  // The other half: if the source of the whole report fails, there is no
  // report — and that must not read as "nothing pending" either.
  const dir = await hermeticBin();
  await writeFile(join(dir, "brew"), "#!/bin/sh\necho 'Error: nope' >&2\nexit 1\n");
  await chmod(join(dir, "brew"), 0o755);
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge"], home, { PATH: dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /brew outdated failed/);
});

test("a --only slice hiding a self-updating cask does not claim the machine is clean", async () => {
  // Found by review, and only reachable end to end: the count lives in
  // buildOverview, not in the renderer. Filtering the self-updating half
  // without counting what the filter removed let `filteredOut` stay 0, and the
  // headline fell through to the one sentence this whole change exists to
  // delete — measured as "nothing outdated — brew has no newer version for
  // anything installed" with gcloud-cli twelve versions behind.
  const selfy = `printf '{"formulae":[],"casks":[{"name":"selfy","installed_versions":["1.0.0"],"current_version":"2.0.0"}]}'`;
  const dir = await fakeBrew(
    `case "$1:$3" in outdated:--greedy-auto-updates) ${selfy} ;; outdated:*) printf '{"formulae":[],"casks":[]}' ;; esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  // --only has to name something the config knows, or the run stops on "nothing
  // matched" before a report is ever rendered. `app` is tracked and is not the
  // cask, which is exactly the slice that used to over-claim.
  const r = await runCli(["overview", "--no-judge", "--only", "app"], home, { PATH: dir });
  assert.doesNotMatch(r.stdout, /anything installed/, "the over-claim must not come back via --only");
  assert.match(r.stdout, /pending outside that filter/);
});

test("--yes --dry-run prints the commands and runs none of them", async (t) => {
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  // A command that would be visible if it ran: it writes a file. Asserting on
  // absence of output would pass just as well against a command that ran and
  // printed nothing.
  const marker = join(await freshHome(), "ran");
  await writeConfig(home, [tool({ source: url, update: `touch ${marker}` })]);

  const r = await runCli(["digest", "--yes", "--dry-run", "--no-judge"], home);
  assert.match(r.stdout, /would run 1 command:/);
  assert.match(r.stdout, new RegExp(`\\$ touch ${marker}`), "the real update line, not a summary of it");
  assert.match(r.stdout, /nothing was run/);
  await assert.rejects(readFile(marker), "the update command actually ran");
  assert.equal(r.code, 1, "nothing was updated, so what was pending still is");
});

test("--yes --dry-run reports a placeholder before an unattended run trips over it", async (t) => {
  // The case that earns this flag: `sh -c '# complete this'` exits 0, so a
  // real --yes reports a successful update that never happened. Finding that
  // out from a dry run beats finding it out from a cron log.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url, update: "# complete this: update it" })]);

  const r = await runCli(["digest", "--yes", "--dry-run", "--no-judge"], home);
  assert.match(r.stderr, /still a placeholder/);
  assert.match(r.stdout, /nothing to run/);
  assert.equal(r.code, 2);
});

test("--brew-upgrade --dry-run does not upgrade the machine", async (t) => {
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url })]);
  // A brew that fails loudly if it is called at all: --dry-run must not reach
  // it, and "did not run" is otherwise indistinguishable from "ran quietly".
  const dir = await hermeticBin();
  await writeFile(join(dir, "brew"), "#!/bin/sh\necho 'BREW WAS CALLED' >&2\nexit 1\n");
  await chmod(join(dir, "brew"), 0o755);

  const r = await runCli(["digest", "--brew-upgrade", "--dry-run", "--no-judge"], home, { PATH: dir });
  // Two lines, in the order they run: update before the report, upgrade after.
  assert.match(r.stdout, /\$ brew update\n\s*\$ brew upgrade\n/, "it still has to say what it would run");
  assert.doesNotMatch(r.stderr, /BREW WAS CALLED/, "the dry run reached brew anyway");
});

/**
 * Signal a running CLI and hand back the code it exited with.
 *
 * The `exit` listener goes on BEFORE the signal, and that ordering is the
 * whole point: if the run finishes on its own first, `exit` has already fired
 * and a listener attached after `kill()` waits for an event that will never
 * come again. Measured 2026-09-02 — that race is why this suite stalled here
 * for a job's entire time budget on both ubuntu and macOS while printing not
 * one line of failure, twice costing over two hours of runner time.
 *
 * It also refuses a run that was already over: signalling a process that has
 * exited tests nothing, and a test that quietly stops testing is worse than
 * one that fails, because it keeps reporting green.
 *
 * `exit` rather than `close`: `close` additionally waits for every stdio
 * stream, which a child that outlived the run still holds open — the exact
 * failure the assertions below are here to catch.
 */
async function signalAfter(
  p: ReturnType<typeof spawnCli>,
  ms: number,
  signal: NodeJS.Signals,
): Promise<number | null> {
  let alive = true;
  const exited = new Promise<number | null>((resolve) => {
    p.on("exit", (code) => {
      alive = false;
      resolve(code);
    });
  });
  await wait(ms);
  assert.ok(alive, `the run ended before it could be signalled — ${signal} was never tested`);
  p.kill(signal);
  return exited;
}

test("Ctrl-C exits 130 and takes the running child with it", async (t) => {
  // Measured before this existed: SIGINT killed the process and left its child
  // running, reparented. For a judge that is a `claude` still working; for
  // --yes a `brew upgrade` still compiling.
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const marker = join(await freshHome(), "survived");
  await writeConfig(home, [tool({ source: url, version: slowProbe(marker) })]);

  const p = spawnCli(["digest", "--no-judge"], home);
  // long enough for the probe to have started
  const code = await signalAfter(p, 1200, "SIGINT");
  assert.equal(code, 130, "128+SIGINT is what a shell reports, and scripts read it");

  // Outlive the probe's own sleep: if it was merely orphaned rather than
  // killed, this is when it would write its marker.
  await wait(4000);
  await assert.rejects(readFile(marker), "the child outlived the run that started it");
});

test("a reader that walks away is not reported as updates being available", async () => {
  // `bumpii list | head` — Node ignores SIGPIPE and raises an `error` event
  // instead, which with no listener is an unhandled throw: a stack trace and
  // exit 1. Every scheduled use reads 1 as "updates available", so the tool's
  // own crash wore its most ordinary answer. Measured before the fix: a 240 KB
  // report cut off after 60 bytes, exit 1.
  //
  // Enough entries that the report cannot fit in the 64 KB pipe buffer — a
  // short one is written and buffered before the reader is gone, and nothing
  // ever fails.
  const home = await freshHome();
  const many = Array.from({ length: 2000 }, (_, i) => tool({ name: `tool${i}`, source: `github:o/r${i}` }));
  await writeConfig(home, many);

  const p = spawnCli(["list"], home);
  let bytes = 0;
  let stderr = "";
  p.stdout.on("data", (d) => {
    bytes += d.length;
    p.stdout.destroy(); // the reader leaves after the first chunk
  });
  p.stdout.on("error", () => {});
  p.stderr.on("data", (d) => {
    stderr += d;
  });
  const code = await new Promise<number | null>((resolve) => p.on("exit", resolve));

  assert.ok(bytes > 0 && bytes < 100_000, `the reader has to leave mid-report, got ${bytes} bytes`);
  assert.notEqual(code, 1, "1 is what a scheduler acts on as pending updates");
  // Not a strict 141: the child and the reader's destroy() are still a race,
  // and the child occasionally finishes writing everything before the reader
  // closes at all — a real success, correctly exit 0. 141 only where a write
  // actually hit the closed pipe. Measured on the fixed build, across many
  // concurrent runs of this same scenario (review of 268b1ce): a small
  // fraction (17/1200) came back 0 instead of 141, none ever 1. What must
  // never happen is the crash the pipe used to cause.
  assert.ok([0, 141].includes(code as number), `expected 0 or 141, got ${code}`);
  assert.doesNotMatch(stderr, /EPIPE|Unhandled/, "a closed pipe must not print a stack trace");
});

test("a reader that walks away still is not reported as pending under a loaded machine", async () => {
  // bumpii#4: the single-spawn version above passes 10/10 locally and still
  // saw exit 1 on a macOS runner. Cause: process.stdout to a pipe is a
  // net.Socket, and the report loop's burst of synchronous writes does not
  // all fail the closed reader the same way — the first write past the close
  // gets EPIPE (handled), but a later one in the same burst can land after
  // the socket has already flipped to disconnected and gets ENOTCONN
  // instead. exitQuietlyOnBrokenPipe matched EPIPE alone and re-threw that
  // ENOTCONN uncaught: exit 1, the exact answer the fix exists to prevent,
  // thrown from inside the function guarding against it.
  //
  // That exact regression is now pinned deterministically and cheaply by
  // "isReaderGoneError covers the whole broken-pipe family" in
  // test/logic.test.ts — reverting the fix fails that test on every run, not
  // "most" runs, because it is a plain value check with no OS timing in it.
  // This loop cannot be that deterministic (it is real processes racing a
  // real pipe close, at whatever the machine's own scheduler does), so it is
  // not the thing pinning the regression — it is what a plain-value test
  // cannot be: proof exitQuietlyOnBrokenPipe is wired to real streams under
  // the concurrency bumpii#4 needed to show the bug at all.
  //
  // Sized for cost, not for guaranteed detection: at RUNS=40/CONCURRENCY=8
  // this test itself costs ~9s CPU (user+sys, measured with `time -l`), 60s
  // timeout, one spawn essentially never lands the race (measured: 0/10).
  // Reverted to EPIPE-only, 7 batches of 40 hit exit 1 in 4 of the 7 (2, 0, 0,
  // 2, 2, 1, 0 — 7 exit-1s over 280 runs); fixed, 8 batches of 40 (320 runs
  // total, three at this same size while calibrating cost, five as the final
  // check) never did.
  const home = await freshHome();
  runtimeDirs.push(home);
  const many = Array.from({ length: 2000 }, (_, i) => tool({ name: `tool${i}`, source: `github:o/r${i}` }));
  await writeConfig(home, many);

  const RUNS = 40;
  const CONCURRENCY = 8;

  const once = () =>
    new Promise<{ code: number | null; bytes: number; stderr: string }>((resolve) => {
      const p = spawnCli(["list"], home);
      let bytes = 0;
      let stderr = "";
      p.stdout.on("data", (d) => {
        bytes += d.length;
        p.stdout.destroy(); // the reader leaves after the first chunk
      });
      p.stdout.on("error", () => {});
      p.stderr.on("data", (d) => {
        stderr += d;
      });
      p.on("exit", (code) => resolve({ code, bytes, stderr }));
    });

  const results: Array<{ code: number | null; bytes: number; stderr: string }> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < RUNS) {
      next++;
      results.push(await once());
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  assert.equal(results.length, RUNS);
  // A floor, not just an absence check: every run reporting bytes >=
  // 100_000 (the full ~66 KB report, read whole) would mean the reader never
  // actually raced a write — the exact way this guard could go quiet without
  // any assertion here turning red. At least half actually hitting the
  // closed pipe (141) is what proves the mechanism under test still fires.
  const brokenPipeHits = results.filter((r) => r.code === 141).length;
  assert.ok(
    brokenPipeHits >= RUNS / 2,
    `expected most runs to hit the closed pipe (code 141); got ${brokenPipeHits}/${RUNS} — ` +
      "the reader may no longer be racing a write at all",
  );
  const ones = results.filter((r) => r.code === 1);
  assert.equal(
    ones.length,
    0,
    `1 is what a scheduler acts on as pending updates; got it ${ones.length}/${RUNS} times — ` +
      `e.g.: ${ones[0]?.stderr.slice(0, 500)}`,
  );
  const crashed = results.filter((r) => /EPIPE|Unhandled/.test(r.stderr));
  assert.equal(crashed.length, 0, "a closed pipe must not print a stack trace, on any run");
});

test("a closed terminal takes the children with it, the way Ctrl-C does", async (t) => {
  // SIGHUP is what a closing terminal sends, and it is the case where stranded
  // children matter most — nobody is left watching a `claude` or a `brew
  // upgrade` that outlives the run. Node's default for it terminates without
  // running exit listeners, exactly like SIGINT, so only SIGINT and SIGTERM
  // being handled meant this path kept the old behaviour.
  //
  // This used to run without a stub forge, on the assumption that "an entry
  // with no source never reaches a forge, and its probe starts either way".
  // Measured 2026-09-03, that is simply untrue: with no source the probe never
  // starts at all, `digest` is done in ~1.35s, and the run was already over by
  // the time the signal arrived. So there was never a child here to take along
  // — the test signalled a corpse and asserted nothing, for two months.
  //
  // A stub forge is what keeps the run alive long enough to have a child worth
  // signalling, the same way the Ctrl-C test above does it. The cost is that
  // this now skips where a loopback port cannot be bound; CI forbids skips, so
  // the coverage is real exactly where it is claimed.
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const marker = join(await freshHome(), "survived");
  await writeConfig(home, [tool({ source: url, version: slowProbe(marker) })]);

  const p = spawnCli(["digest", "--no-judge"], home);
  // long enough for the probe to have started
  const code = await signalAfter(p, 1200, "SIGHUP");
  assert.equal(
    code,
    129,
    "128+SIGHUP is what a shell reports, and an unhandled signal reports no code at all",
  );

  // Outlive the probe's own sleep: if it was merely orphaned, this is when it
  // would write its marker.
  await wait(4000);
  await assert.rejects(readFile(marker), "the probe outlived the terminal that started it");
});

test("a run that ends early does not strand a probe it started", async (t) => {
  // No signal involved. A tool's probe and its forge fetch are one
  // Promise.all, so a failing fetch rejects the pair while the probe is still
  // running; the report prints and the process exits out from under it.
  const broken = await stubForgeFailing();
  if (!broken) return t.skip(SKIP);
  const home = await freshHome();
  const marker = join(await freshHome(), "survived");
  await writeConfig(home, [tool({ source: broken, version: slowProbe(marker) })]);

  const r = await runCli(["digest", "--no-judge"], home);
  assert.equal(r.code, 2, "the forge failed, so the run cannot report all-clear");

  await wait(4000);
  await assert.rejects(readFile(marker), "the probe kept running after bumpii exited");
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

/**
 * A tool whose version is a file, so an update line can change it.
 *
 * Absolute `/bin/cat`, because the tests that run update commands put a
 * hermetic PATH in front of the CLI. "The version changed" against "it did
 * not" is then a one-character difference in the update line, which is what
 * the checks after an update have to be able to tell apart.
 */
async function fileTool(
  home: string,
  version: string,
  over: Record<string, unknown> | ((verFile: string) => Record<string, unknown>) = {},
) {
  const verFile = join(home, "version");
  await writeFile(verFile, version);
  // A function, for the update lines that have to name the file they change.
  const fields = typeof over === "function" ? over(verFile) : over;
  // Anchored, as AGENTS.md says every pattern must be: the probe matches over
  // stdout and stderr together, and once the file is gone cat's error names
  // its path — which contains digits. Unanchored, the re-probe read "now 4"
  // out of "/var/folders/fy/4rj…" and called the tool updated.
  return {
    verFile,
    tool: tool({ version: { cmd: ["/bin/cat", verFile], match: "^([0-9][0-9.]*)" }, ...fields }),
  };
}

/** A fake brew on a hermetic PATH: `$1` decides, `outdated` answers JSON. */
async function fakeBrew(script: string): Promise<string> {
  const dir = await hermeticBin();
  await writeFile(join(dir, "brew"), `#!/bin/sh\n${script}\n`);
  await chmod(join(dir, "brew"), 0o755);
  return dir;
}

const NOTHING_OUTDATED = `printf '{"formulae":[],"casks":[]}'`;

test("an update command's output arrives while it is still running", async (t) => {
  // Buffered, the first line of a ten-minute brew upgrade shows up when the
  // last one does. This proves causality, not timing: the child prints FIRST,
  // then waits for a file the test creates only once FIRST has reached its
  // pipe. STREAMED can only appear if bytes crossed while the child was alive;
  // a buffered run prints BUFFERED after ten seconds, cleanly, not a hang.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const go = join(home, "GO");
  // /bin/sleep by path, integer seconds: BSD and GNU sleep disagree about
  // fractions, and the hermetic PATH has no sleep at all.
  const { tool: app } = await fileTool(home, "1.0.0", (verFile) => ({
    source: url,
    update:
      `printf 'FIRST\\n'; i=0; while [ ! -f ${go} ] && [ $i -lt 10 ]; do /bin/sleep 1; i=$((i+1)); done; ` +
      `if [ -f ${go} ]; then printf 'STREAMED\\n'; else printf 'BUFFERED\\n'; fi; printf 2.0.0 > ${verFile}`,
  }));
  await writeConfig(home, [app]);

  const p = spawnCli(["digest", "--yes", "--no-judge"], home, { PATH: await hermeticBin() });
  let stdout = "";
  let stderr = "";
  p.stdout.on("data", (d) => {
    stdout += d;
    // The bare line, not the word: the report quotes the update line, FIRST
    // included, before the command ever runs — a substring match released the
    // child from the report alone and passed against the buffered path too.
    if (/^FIRST$/m.test(stdout)) void writeFile(go, "");
  });
  p.stderr.on("data", (d) => {
    stderr += d;
  });
  const code = await new Promise<number | null>((resolve) => p.on("exit", resolve));
  // Line-anchored: the update line itself, quoted in the report and echoed
  // before it runs, contains both words.
  assert.match(stdout, /^STREAMED$/m, `the update's output was held back until it exited: ${stderr}`);
  assert.doesNotMatch(stdout, /^BUFFERED$/m);
  assert.equal(code, 0, stderr);
});

test("the echo line is not overtaken by the child it announces", async (t) => {
  // stdout on a pipe is asynchronous, and a child with inherited stdio writes
  // past whatever the parent still has queued — measured: at byte 65536 of a
  // 300 KB backlog. A fast reader hides this, because the parent's queue is
  // empty by the time the child starts, so the backlog is manufactured here:
  // a report over the 64 KiB pipe buffer, and a reader that does not read for
  // 300 ms. Stated honestly: without the flush this can still pass on a quiet
  // machine, which is why the report size is asserted as a fixture guard.
  const tags = Array.from({ length: 3000 }, (_, i) => `v1.0.${i + 1}`);
  const url = await stubForge(tags);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url, update: "printf 'FIRST\\n'" });
  await writeConfig(home, [app]);

  const p = spawnCli(["digest", "--yes", "--no-judge"], home, { PATH: await hermeticBin() });
  p.stdout.pause();
  await wait(300);
  let stdout = "";
  p.stdout.on("data", (d) => {
    stdout += d;
  });
  p.stdout.resume();
  await new Promise((resolve) => p.on("exit", resolve));
  assert.ok(
    stdout.length > 65536,
    `fixture guard: the report has to exceed the pipe buffer, got ${stdout.length}`,
  );
  const echo = stdout.indexOf("$ printf");
  const first = stdout.indexOf("FIRST\n");
  assert.ok(echo >= 0 && first >= 0, "both the echo line and the child's line have to be there");
  assert.ok(echo < first, "the child's output arrived before the line announcing it");
});

test("a reader that leaves during an update is not an update failure", async (t) => {
  // The child inherits the pipe, so when `| head` has gone its next write is
  // SIGPIPE. That is the reader walking away — the same event
  // exitQuietlyOnBrokenPipe answers 141 for when it hits this process's own
  // write — and neither 1 (pending) nor 2 (failed), which a scheduler would
  // act on.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", {
    source: url,
    update: "printf 'FIRST\\n'; /bin/sleep 1; printf 'SECOND\\n'",
  });
  await writeConfig(home, [app]);

  const p = spawnCli(["digest", "--yes", "--no-judge"], home, { PATH: await hermeticBin() });
  let stdout = "";
  p.stdout.on("data", (d) => {
    stdout += d;
    // The child's own line, not the report quoting its command: the reader has
    // to leave while the child is running, or the parent's echo hits EPIPE
    // first and this measures exitQuietlyOnBrokenPipe instead.
    if (/^FIRST$/m.test(stdout)) p.stdout.destroy();
  });
  p.stdout.on("error", () => {});
  const code = await new Promise<number | null>((resolve) => p.on("exit", resolve));
  assert.equal(code, 141);
});

test("--brew-upgrade runs brew update before brew outdated, and brew upgrade last", async (t) => {
  // The "other packages pending" count comes from `brew outdated`, which
  // answers from the tap as last fetched. Updating first is what makes that
  // count current; upgrading last is what keeps the report ahead of it.
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url });
  await writeConfig(home, [app]);
  const log = join(home, "brew.log");
  const dir = await fakeBrew(`echo "$1" >> ${log}\ncase "$1" in outdated) ${NOTHING_OUTDATED} ;; esac`);

  const r = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  assert.equal(r.code, 0, r.stderr);
  // Two `outdated` calls: the plain listing, then the --greedy one that reveals
  // the casks the plain one hides. Both sit between update and upgrade, which
  // is the ordering this test exists for.
  assert.equal(await readFile(log, "utf8"), "update\noutdated\noutdated\nupgrade\n");
});

test("a cask only --greedy reveals is named, not counted as nothing pending", async (t) => {
  // The end-to-end half of the gcloud-cli bug: `brew outdated` answers with an
  // empty list while `--greedy` has a cask two versions behind. Without the
  // greedy call the report reads "no other brew updates pending" and stops —
  // true about the question it asked, false about the machine. Driving a real
  // brew stub is what holds the FLAG in place; a unit test on the subtraction
  // stays green if the argument is dropped.
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url });
  await writeConfig(home, [app]);
  const greedy = `printf '{"formulae":[],"casks":[{"name":"selfy","installed_versions":["1.0.0"],"current_version":"2.0.0"}]}'`;
  // The flag is part of what this pins: --greedy would also drag in
  // `version :latest` casks, which brew can only compare by DOWNLOADING the
  // artefact. A read-only report must not do that.
  const dir = await fakeBrew(
    `case "$1:$3" in outdated:--greedy-auto-updates) ${greedy} ;; outdated:*) ${NOTHING_OUTDATED} ;; esac`,
  );

  const r = await runCli(["digest", "--no-judge"], home, { PATH: dir });
  // 0, deliberately: the exit code answers "is a TRACKED tool behind", and an
  // untracked cask does not change that any more than `otherPending` does. The
  // report names it; the code keeps its existing meaning.
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 self-updating cask is behind: selfy/);
  assert.match(r.stdout, /brew upgrade will not touch it/);
});

test("a failed plain listing produces no self-updating line, not a wrong one", async (t) => {
  // Found by review. `brewSelfUpdating(outdated ?? [])` reads a failed plain
  // listing as "nothing pending", so the subtraction subtracts nothing and
  // every ordinary pending FORMULA comes back out of it labelled a
  // self-updating cask brew will not touch — measured with gh and node. No
  // plain answer has to mean no line.
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url });
  await writeConfig(home, [app]);
  const formulae = `printf '{"formulae":[{"name":"gh","installed_versions":["1.0.0"],"current_version":"2.0.0"}],"casks":[]}'`;
  const dir = await fakeBrew(
    `case "$1:$3" in outdated:--greedy-auto-updates) ${formulae} ;; outdated:*) echo 'Error: nope' >&2; exit 1 ;; esac`,
  );

  const r = await runCli(["digest", "--no-judge"], home, { PATH: dir });
  assert.doesNotMatch(r.stdout, /self-updating/, "a formula must never be described as a cask");
  assert.doesNotMatch(r.stdout, /gh/, "and it must not be named under a heading that does not fit");
});

test("digest --json carries the self-updating casks, not just the pending count", async (t) => {
  // Found by review: a cron reading only `otherPending: 0` got a clean
  // all-clear over a cask twelve versions behind — the machine-readable half of
  // the same bug.
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url });
  await writeConfig(home, [app]);
  const selfy = `printf '{"formulae":[],"casks":[{"name":"selfy","installed_versions":["1.0.0"],"current_version":"2.0.0"}]}'`;
  const dir = await fakeBrew(
    `case "$1:$3" in outdated:--greedy-auto-updates) ${selfy} ;; outdated:*) ${NOTHING_OUTDATED} ;; esac`,
  );

  const r = await runCli(["digest", "--no-judge", "--json"], home, { PATH: dir });
  const parsed = JSON.parse(r.stdout) as { otherPending?: number; selfUpdatingNames?: string[] };
  assert.equal(parsed.otherPending, 0);
  assert.deepEqual(parsed.selfUpdatingNames, ["selfy"]);
});

test("a failed brew update skips the upgrade instead of running it blind", async (t) => {
  // `brew update && brew upgrade` had the && for a reason; the two now run
  // apart, and the reason has to survive the split. A count of pending
  // packages from a tap that just failed to refresh is not offered either.
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url });
  await writeConfig(home, [app]);
  const dir = await fakeBrew(
    `case "$1" in\n  update) echo 'no network' >&2; exit 1 ;;\n  upgrade) echo 'BREW UPGRADE WAS CALLED' ;;\n  outdated) ${NOTHING_OUTDATED} ;;\nesac`,
  );

  const r = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  // execFile's message carries the command's stderr on its own lines.
  assert.match(r.stderr, /brew update failed: [\s\S]*no network/);
  assert.match(r.stderr, /brew upgrade skipped/);
  assert.doesNotMatch(r.stdout + r.stderr, /BREW UPGRADE WAS CALLED/);
  assert.doesNotMatch(r.stdout, /other package/, "a stale count was presented as current");
  assert.equal(r.code, 2);
});

test("brew runs without its env hints, unless the user set the variable themselves", async (t) => {
  // Six lines of HOMEBREW_NO_ENV_HINTS advice repeated on every run. Set for
  // the child only when unset: an exported-but-empty value is the user's own
  // setting and stays — `??`, the opposite of the XDG_CONFIG_HOME rule.
  const url = await stubForge(["v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url });
  await writeConfig(home, [app]);
  const dir = await fakeBrew(
    `case "$1" in\n  upgrade) echo "HINTS=\${HOMEBREW_NO_ENV_HINTS-unset}" ;;\n  outdated) ${NOTHING_OUTDATED} ;;\nesac`,
  );

  const r = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  assert.match(r.stdout, /^HINTS=1$/m, r.stdout);
  const kept = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, {
    PATH: dir,
    HOMEBREW_NO_ENV_HINTS: "",
  });
  assert.match(kept.stdout, /^HINTS=$/m, "an exported-but-empty variable was overwritten");
});

// The re-probe after an update. Every test here runs on a hermetic PATH: the
// verdict for "still on the old version" reads brew's pending list, and the
// developer's real brew must never be the one deciding an exit code.

test("a tool that really updated is reported as now on the new version", async (t) => {
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", (verFile) => ({
    source: url,
    update: `printf 2.0.0 > ${verFile}`,
  }));
  await writeConfig(home, [app]);

  const r = await runCli(["--yes", "--no-judge"], home, { PATH: await hermeticBin() });
  assert.match(r.stdout, /^app: now 2\.0\.0$/m, r.stdout);
  assert.doesNotMatch(r.stdout, /still/);
  assert.equal(r.code, 0, r.stderr);
});

test("a tool brew still lists after a clean upgrade is a failure, not a success", async (t) => {
  // brew upgrade exited 0 and the binary on PATH still answers the old
  // version: the classic shadowed install. Exit 0 here was the old behaviour.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url, update: "brew upgrade app" });
  await writeConfig(home, [app]);
  const listed = JSON.stringify({
    formulae: [{ name: "app", installed_versions: ["1.0.0"], current_version: "2.0.0" }],
    casks: [],
  });
  const dir = await fakeBrew(`case "$1" in outdated) printf '%s' '${listed}' ;; esac`);

  const r = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  assert.match(r.stdout, /^app: still 1\.0\.0 — brew listed 2\.0\.0 and the upgrade exited 0/m, r.stdout);
  assert.match(r.stdout, /which -a/);
  assert.doesNotMatch(r.stdout, /did not list/);
  assert.equal(r.code, 2);
});

test("a tool brew has nothing newer for is still pending, not broken", async (t) => {
  // The release is out, the formula has not caught up: brew upgrade had
  // nothing to do, and saying so is different from saying it failed.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url, update: "brew upgrade app" });
  await writeConfig(home, [app]);
  const dir = await fakeBrew(`case "$1" in outdated) ${NOTHING_OUTDATED} ;; esac`);

  const r = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  assert.match(r.stdout, /^app: still 1\.0\.0 — brew outdated did not list it/m, r.stdout);
  assert.match(r.stdout, /2\.0\.0 is published upstream/);
  assert.doesNotMatch(r.stdout, /may not be brew's/);
  assert.equal(r.code, 1);
});

test("a probe that fails after the update is not folded into success", async (t) => {
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", (verFile) => ({
    source: url,
    update: `/bin/rm ${verFile}`,
  }));
  await writeConfig(home, [app]);

  const r = await runCli(["--yes", "--no-judge"], home, { PATH: await hermeticBin() });
  assert.match(r.stdout, /^app: could not probe after the update/m, r.stdout);
  assert.doesNotMatch(r.stdout, /\b(now|still) [0-9]/, "a version it could not read must not be stated");
  assert.equal(r.code, 2);
});

test("--brew-upgrade names an update line brew never ran, and leaves it pending", async (t) => {
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url, update: "claude update" });
  await writeConfig(home, [app]);
  const dir = await fakeBrew(`case "$1" in outdated) ${NOTHING_OUTDATED} ;; esac`);

  const r = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  assert.match(
    r.stdout,
    /→ claude update\s+\(not run by brew upgrade\)/,
    "the report marks it before the upgrade",
  );
  assert.match(r.stdout, /^app: still 1\.0\.0 — its update line is not brew's: claude update$/m, r.stdout);
  assert.equal(r.code, 1);
});

test("a failed brew upgrade is not described as having exited 0", async (t) => {
  // Measured before the fix: stderr said "brew upgrade failed: exited 1" and
  // stdout, in the same second, "brew listed 2.0.0 and the upgrade exited 0,
  // so the … on PATH may not be brew's" — two lines contradicting each other,
  // the wrong one sending the reader after a shadow install that is not there.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url, update: "brew upgrade app" });
  await writeConfig(home, [app]);
  const listed = JSON.stringify({
    formulae: [{ name: "app", installed_versions: ["1.0.0"], current_version: "2.0.0" }],
    casks: [],
  });
  const dir = await fakeBrew(
    `case "$1" in\n  outdated) printf '%s' '${listed}' ;;\n  upgrade) echo 'bottle download failed' >&2; exit 1 ;;\nesac`,
  );

  const r = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  assert.match(r.stderr, /brew upgrade failed: exited 1/);
  assert.match(r.stdout, /^app: still 1\.0\.0 — brew upgrade did not complete/m, r.stdout);
  assert.doesNotMatch(r.stdout, /exited 0|which -a/, "a failed upgrade must not be called a clean one");
  assert.equal(r.code, 2);
});

test("--brew-upgrade alone reports a placeholder entry as broken, not as a non-brew line", async (t) => {
  // --yes names a placeholder for what it is and exits 2; the same entry
  // under --brew-upgrade alone fell through to "its update line is not
  // brew's: # complete this: …" and exit 1 — an unfinished entry filed as an
  // ordinary one.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", {
    source: url,
    update: "# complete this: pull and restart",
  });
  await writeConfig(home, [app]);
  const dir = await fakeBrew(`case "$1" in outdated) ${NOTHING_OUTDATED} ;; esac`);

  const r = await runCli(["digest", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  assert.match(r.stderr, /app: update line is still a placeholder/);
  assert.doesNotMatch(r.stdout, /not brew's/);
  assert.equal(r.code, 2);
});

test("--yes --brew-upgrade after a failed brew update skips the per-tool brew lines too", async (t) => {
  // The && of `brew update && brew upgrade` has to cover a tool's own
  // `brew upgrade x` line as well: eight of them running against the tap
  // that just failed to refresh, right before "brew upgrade skipped — brew
  // update failed above", is the reason applied to half the commands.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  const { tool: app } = await fileTool(home, "1.0.0", { source: url, update: "brew upgrade app" });
  await writeConfig(home, [app]);
  const dir = await fakeBrew(
    `case "$1" in\n  update) echo 'no network' >&2; exit 1 ;;\n  upgrade) echo 'BREW UPGRADE WAS CALLED' ;;\n  outdated) ${NOTHING_OUTDATED} ;;\nesac`,
  );

  const r = await runCli(["digest", "--yes", "--brew-upgrade", "--no-judge"], home, { PATH: dir });
  assert.match(r.stderr, /app: brew upgrade app — skipped, brew update failed above/);
  assert.doesNotMatch(r.stdout + r.stderr, /BREW UPGRADE WAS CALLED/);
  assert.doesNotMatch(r.stdout, /not run by brew upgrade|brew upgrade runs next/, "nothing runs next");
  assert.equal(r.code, 2);
});

test("a --json report larger than the pipe buffer arrives whole", async (t) => {
  // process.exit drops whatever Node still has queued for stdout, and stdout
  // is asynchronous on a pipe — which is every consumer reading this with
  // `$( )`. The report used to stop dead at 65536 bytes while the exit code
  // still reported success: a truncated document, handed over as a complete
  // one. runCli spawns with piped stdio, so this is the real case, not a
  // simulation of it.
  const url = await stubForge(["v2.0.0", "v1.0.0"], "x".repeat(80_000));
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  await writeConfig(home, [tool({ source: url })]);

  const r = await runCli(["--json", "--no-judge"], home);
  assert.doesNotThrow(
    () => JSON.parse(r.stdout),
    `a truncated report is a parse error for everything downstream (${r.stdout.length} bytes)`,
  );
  // Guards the fixture, not the fix: should the notes ever stop reaching past
  // the buffer, the assertion above would pass without having tested anything.
  assert.ok(r.stdout.length > 65536, `too small to reach the pipe buffer: ${r.stdout.length} bytes`);
});

test("--json --yes keeps stdout to one document", async (t) => {
  // The report is written first and the update loop writes to stdout after it,
  // so `bumpii digest --json --yes | jq` got a JSON document with shell output
  // glued onto the end — a parse error for every consumer, and exactly the
  // combination an unattended run uses. The update output is still shown; it
  // moves to stderr, where the progress line and every other human-facing line
  // already live.
  const url = await stubForge(["v2.0.0", "v1.0.0"]);
  if (!url) return t.skip(SKIP);
  const home = await freshHome();
  // A real update, not a pretend one: the version file moves to 2.0.0, so the
  // exit code below is 0 for the right reason once the run checks its work.
  const { tool: app } = await fileTool(home, "1.0.0", (verFile) => ({
    source: url,
    update: `echo pretending-to-upgrade; printf 2.0.0 > ${verFile}`,
  }));
  await writeConfig(home, [app]);

  const r = await runCli(["digest", "--json", "--yes", "--no-judge"], home);
  assert.doesNotThrow(
    () => JSON.parse(r.stdout),
    `stdout must be the document alone, got: ${r.stdout.slice(-200)}`,
  );
  // Line-anchored: the document quotes the update line inside a JSON string;
  // what must not be there is the command's bare output line.
  assert.doesNotMatch(r.stdout, /^pretending-to-upgrade$/m, "the update's output leaked into the document");
  assert.match(r.stderr, /^pretending-to-upgrade$/m, "the update output still has to be shown");
  assert.equal(r.code, 0, "the update itself succeeded");
});

// --- overview --brew-upgrade -------------------------------------------------
//
// These need no forge stub on purpose: with no usagePaths every package has a
// reference count of zero, so overview never contacts a forge and the run is
// the brew half alone — which is the half the upgrade path is made of. That
// also keeps them out of the group that skips when a port cannot be bound.

const UV_PENDING = `printf '{"formulae":[{"name":"uv","installed_versions":["0.1.0"],"current_version":"0.2.0"}],"casks":[]}'`;
const NOTHING = `printf '{"formulae":[],"casks":[]}'`;
const SELFY = `printf '{"formulae":[],"casks":[{"name":"selfy","installed_versions":["1.0.0"],"current_version":"2.0.0"}]}'`;

test("overview --brew-upgrade reaches brew, in the order the report depends on", async () => {
  // The regression this pins: the flag was parsed, accepted, and dropped —
  // `overview` returned before the upgrade block could ever run, so the run
  // printed a report and exited 0 having upgraded nothing. Asserted against
  // brew's own call log, because the report quotes `→ brew upgrade uv` either
  // way and matching that string passes without brew ever being called.
  const scratch = await freshHome();
  const log = join(scratch, "log");
  const done = join(scratch, "done");
  const dir = await fakeBrew(
    `echo "$1" >> ${log}
case "$1" in
  update) exit 0 ;;
  upgrade) : > ${done} ; exit 0 ;;
  outdated) if [ -f ${done} ]; then ${NOTHING} ; else ${UV_PENDING} ; fi ;;
  *) printf '{"formulae":[]}' ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade"], home, { PATH: dir });
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.ok(calls.includes("upgrade"), "the flag has to reach brew, not just be accepted");
  assert.equal(calls[0], "update", "the listing the report is built from must come after the refresh");
  assert.ok(calls.indexOf("update") < calls.indexOf("outdated"), "update, then the listing");
  assert.ok(
    calls.lastIndexOf("outdated") > calls.indexOf("upgrade"),
    "brew is asked again after the upgrade",
  );
  assert.equal(r.code, 0, "brew stopped listing it, so nothing is pending any more");
});

test("a package brew still lists after the upgrade is never called updated", async () => {
  // `brew upgrade` exits 0 with a package still pending whenever brew has no
  // newer bottle yet. The reassuring string has to be absent, not merely
  // outweighed by a second line somewhere below it.
  const dir = await fakeBrew(
    `case "$1" in
  outdated) ${UV_PENDING} ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade"], home, { PATH: dir });
  assert.match(r.stdout, /still lists it as outdated/, "the run has to say the upgrade changed nothing");
  assert.doesNotMatch(
    r.stdout,
    /no longer lists/,
    "an upgrade that achieved nothing must not read as success",
  );
  assert.equal(r.code, 1, "still pending is exit 1, not a clean run");
});

test("a greedy upgrade is verified greedily, or every self-updating cask reads as clean", async () => {
  // The trap, and the reason the flag is threaded through to the second read:
  // `brew outdated` never lists an auto_updates cask at all. Ask again without
  // the flag the upgrade used and the cask is simply absent — which the
  // verdict would read as "no longer listed", upgraded or not. This fake never
  // upgrades anything; only asking greedily can tell the difference.
  const dir = await fakeBrew(
    `case "$1:$3" in
  outdated:--greedy-auto-updates) ${SELFY} ;;
  outdated:*) ${NOTHING} ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade", "--greedy-auto-updates"], home, {
    PATH: dir,
  });
  assert.match(r.stdout, /selfy/, "the cask the greedy listing found has to be verified too");
  assert.match(r.stdout, /still lists it as outdated/, "asked greedily, brew still has it");
  assert.doesNotMatch(
    r.stdout,
    /no longer lists/,
    "the plain listing's silence is not evidence of an upgrade",
  );
  assert.equal(r.code, 1);
});

test("--greedy-auto-updates is refused where there is no upgrade to widen", async () => {
  const home = await freshHome();
  await writeConfig(home, [tool()]);
  const r = await runCli(["overview", "--no-judge", "--greedy-auto-updates"], home);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs --brew-upgrade/, "a flag that changes nothing is refused, not swallowed");
});

test("overview --yes runs each entry's own command, with the cask flag brew needs", async () => {
  // What the entry carries is what runs: a cask's line is `brew upgrade --cask
  // <name>`, and dropping the flag makes brew look for a formula by that name.
  const scratch = await freshHome();
  const log = join(scratch, "log");
  const dir = await fakeBrew(
    `echo "$*" >> ${log}
case "$1" in
  outdated) ${SELFY} ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  await runCli(["overview", "--no-judge", "--yes"], home, { PATH: dir });
  const calls = await readFile(log, "utf8");
  assert.match(calls, /^upgrade --cask selfy$/m, "the cask's own command has to run as the entry spells it");
});

test("a second listing that fails is not a clean bill of health", async () => {
  // The re-read is the evidence. If it cannot be taken, the run knows nothing
  // about whether the upgrade worked — and that is exit 2, the same as any
  // other re-probe that could not run.
  const scratch = await freshHome();
  const done = join(scratch, "done");
  const dir = await fakeBrew(
    `case "$1" in
  upgrade) : > ${done} ; exit 0 ;;
  outdated)
    if [ -f ${done} ]; then echo 'Error: brew is broken now' >&2 ; exit 1 ; fi
    ${UV_PENDING} ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade"], home, { PATH: dir });
  assert.match(r.stdout, /could not ask brew again/, "the run has to name what it could not check");
  assert.doesNotMatch(r.stdout, /no longer lists/, "a failed check is not a passed one");
  assert.equal(r.code, 2, "a check that could not run is 2, not 0");
});

test("overview --brew-upgrade --dry-run prints the commands and runs none", async () => {
  const scratch = await freshHome();
  const log = join(scratch, "log");
  const dir = await fakeBrew(
    `echo "$1" >> ${log}
case "$1" in
  outdated) ${UV_PENDING} ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade", "--dry-run"], home, { PATH: dir });
  assert.match(r.stdout, /\$ brew upgrade/);
  assert.match(r.stdout, /nothing was run/);
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.ok(!calls.includes("upgrade"), "--dry-run may print the command but never run it");
  assert.ok(!calls.includes("update"), "nor refresh the tap it would upgrade against");
  assert.equal(r.code, 1, "something is still pending, and a dry run keeps saying so");
});

test("a filtered report does not hide what the global upgrade touched", async () => {
  // --only narrows the report; `brew upgrade` does not narrow with it. Measured
  // before this line existed: `overview --only jq --brew-upgrade` printed
  // "nothing outdated among what --only names" directly above a command that
  // upgraded six other packages, none of them shown and none verified.
  const two = `printf '{"formulae":[{"name":"uv","installed_versions":["0.1.0"],"current_version":"0.2.0"},{"name":"other","installed_versions":["1.0"],"current_version":"2.0"}],"casks":[]}'`;
  const dir = await fakeBrew(
    `case "$1" in
  outdated) ${two} ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--only", "uv", "--brew-upgrade"], home, { PATH: dir });
  assert.match(
    r.stdout,
    /--only kept 1 pending package out of this report/,
    "a run that upgraded more than it showed has to say so",
  );
  // Deliberately not a claim about what `brew upgrade` reached: filteredOut
  // counts the greedy half too, and a non-greedy upgrade never touches those.
  assert.doesNotMatch(r.stdout, /brew upgrade also ranged/);
});

test("an upgrade run names the tracked tools brew never checked", async () => {
  // They are not in `entries`, so nothing ran for them and nothing verified
  // them. Without this line an upgrade that touched only brew reads as the
  // whole machine being current — the tracked non-brew entries sit under a
  // heading well above, easy to take for a footnote about the listing.
  const dir = await fakeBrew(
    `case "$1" in
  outdated) printf '{"formulae":[{"name":"uv","installed_versions":["0.1.0"],"current_version":"0.2.0"}],"casks":[]}' ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  // A container entry: brew does not manage it, so it lands in `unchecked`.
  await writeConfig(home, [tool({ name: "sidecar", update: "docker pull sidecar" })]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade"], home, { PATH: dir });
  assert.match(r.stdout, /sidecar — brew does not manage/, "what the run did not touch has to be named");
  assert.match(r.stdout, /bumpii digest --yes/, "and the command that does touch it");
});

test("a greedy run says so in the report and in what it hands brew", async () => {
  // Two halves of one lie, found by review. The report's own line read "brew
  // upgrade will not touch them" two lines above `$ brew upgrade
  // --greedy-auto-updates` touching them; and nothing held the flag on the
  // WRITE side, so dropping it from the upgrade kept every test green.
  const scratch = await freshHome();
  const log = join(scratch, "log");
  const dir = await fakeBrew(
    `echo "$*" >> ${log}
case "$1:$3" in
  outdated:--greedy-auto-updates) ${SELFY} ;;
  outdated:*) ${NOTHING} ;;
  info:*) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade", "--greedy-auto-updates"], home, {
    PATH: dir,
  });
  assert.doesNotMatch(
    r.stdout,
    /will not touch them/,
    "the report may not promise the opposite of what its own run is about to do",
  );
  assert.match(r.stdout, /this run was asked to upgrade them too/);
  const calls = await readFile(log, "utf8");
  assert.match(
    calls,
    /^upgrade --greedy-auto-updates$/m,
    "the flag has to reach the upgrade, not only the listing",
  );
});

test("a greedy upgrade over a listing that failed does not exit clean", async () => {
  // The run upgraded running applications and cannot name which ones. Saying
  // so on stderr while exiting 0 folds "I do not know what I just did" into
  // the reassuring answer — and a failed SECOND listing already exits 2.
  const dir = await fakeBrew(
    `case "$1:$3" in
  outdated:--greedy-auto-updates) echo 'Error: no greedy here' >&2 ; exit 1 ;;
  outdated:*) ${NOTHING} ;;
  info:*) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade", "--greedy-auto-updates"], home, {
    PATH: dir,
  });
  assert.match(r.stderr, /cannot say which/, "the gap has to be named");
  assert.equal(r.code, 2, "an upgrade whose targets are unknown is not a clean run");
});

test("the re-check quotes brew's second answer, not the first", async () => {
  // Found by review: the fresh listing sits in hand and only `.has()` was read
  // off it. A package that moved 0.1.0 → 0.2.0 while 0.3.0 appeared upstream
  // was reported as "still 0.1.0 → 0.2.0" — a state that no longer exists,
  // reading as though nothing had moved.
  const scratch = await freshHome();
  const done = join(scratch, "done");
  const before = `printf '{"formulae":[{"name":"uv","installed_versions":["0.1.0"],"current_version":"0.2.0"}],"casks":[]}'`;
  const after = `printf '{"formulae":[{"name":"uv","installed_versions":["0.2.0"],"current_version":"0.3.0"}],"casks":[]}'`;
  const dir = await fakeBrew(
    `case "$1" in
  upgrade) : > ${done} ; exit 0 ;;
  outdated) if [ -f ${done} ]; then ${after} ; else ${before} ; fi ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade"], home, { PATH: dir });
  assert.match(
    r.stdout,
    /still lists it as outdated \(0\.2\.0 → 0\.3\.0\)/,
    "the line describes the machine now",
  );
  assert.doesNotMatch(
    r.stdout,
    /\(0\.1\.0 → 0\.2\.0\)/,
    "the pre-upgrade state is not what the re-check measured",
  );
});

test("overview --yes --dry-run keeps a placeholder out of what it says would run", async () => {
  // A placeholder is a comment `sh -c` exits 0 on, so listing it under "would
  // run" describes a run that cannot happen — and it is broken now, not once
  // it runs, which is why it reports 2 rather than 1.
  const dir = await fakeBrew(
    `case "$1" in
  outdated) printf '{"formulae":[{"name":"app","installed_versions":["1.0.0"],"current_version":"2.0.0"}],"casks":[]}' ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool({ name: "app", update: "# TODO: how does this update?" })]);

  const r = await runCli(["overview", "--no-judge", "--yes", "--dry-run"], home, { PATH: dir });
  assert.doesNotMatch(r.stdout, /\$ # TODO/, "a comment must not be printed as a command that would run");
  assert.match(r.stderr, /still a placeholder/);
  assert.equal(r.code, 2, "a placeholder is broken now, not once it runs");
});

test("a failed update is not also blamed by the re-check", async () => {
  // Its own command failed and was counted where it happened. brew will of
  // course still list it; counting that again would report two failures for
  // one event and bury the real message under a second, vaguer one.
  const dir = await fakeBrew(
    `case "$1" in
  outdated) printf '{"formulae":[{"name":"app","installed_versions":["1.0.0"],"current_version":"2.0.0"}],"casks":[]}' ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool({ name: "app", update: "exit 3" })]);

  const r = await runCli(["overview", "--no-judge", "--yes"], home, { PATH: dir });
  assert.match(r.stderr, /update failed/, "the failure is reported where it happened");
  assert.doesNotMatch(r.stdout, /app: brew still lists/, "and not a second time, vaguer, below");
  assert.equal(r.code, 2);
});

test("brew upgrade is skipped when the refresh it depends on failed", async () => {
  // The `&&` of `brew update && brew upgrade`, kept across the split: an
  // upgrade against a tap that failed to refresh is not what was asked for.
  const scratch = await freshHome();
  const log = join(scratch, "log");
  const dir = await fakeBrew(
    `echo "$1" >> ${log}
case "$1" in
  update) echo 'Error: tap is broken' >&2 ; exit 1 ;;
  outdated) ${UV_PENDING} ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--brew-upgrade"], home, { PATH: dir });
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.ok(!calls.includes("upgrade"), "no upgrade against a tap that did not refresh");
  assert.match(r.stderr, /brew upgrade skipped/);
  assert.equal(r.code, 2);
});

test("digest --brew-upgrade --greedy-auto-updates checks the casks it upgraded", async () => {
  // The contract says every package the report named as behind is measured
  // again. Greedy made the self-updating casks upgrade targets, so it made
  // them the contract's business too — before this they were upgraded and
  // never looked at again, under exit 0.
  const dir = await fakeBrew(
    `case "$1:$3" in
  outdated:--greedy-auto-updates) ${SELFY} ;;
  outdated:*) ${NOTHING} ;;
  info:*) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["digest", "--no-judge", "--brew-upgrade", "--greedy-auto-updates"], home, {
    PATH: dir,
  });
  assert.match(
    r.stdout,
    /selfy: brew still lists it as outdated/,
    "an upgraded cask has to be looked at again",
  );
  assert.notEqual(r.code, 0, "a cask the upgrade did not move is not a clean run");
});

test("a failed refresh also stops the per-entry brew lines, not just the global one", async () => {
  // The same `&&` in the other loop: under --yes each entry runs its own
  // `brew upgrade <name>`, and those go against the tap that just failed to
  // refresh. Skipping the global upgrade for that reason while running eight
  // of these applies the reason to half the commands.
  const scratch = await freshHome();
  const log = join(scratch, "log");
  const dir = await fakeBrew(
    `echo "$*" >> ${log}
case "$1" in
  update) echo 'Error: tap is broken' >&2 ; exit 1 ;;
  outdated) ${UV_PENDING} ;;
  info) printf '{"formulae":[]}' ;;
  *) exit 0 ;;
esac`,
  );
  const home = await freshHome();
  await writeConfig(home, [tool()]);

  const r = await runCli(["overview", "--no-judge", "--yes", "--brew-upgrade"], home, { PATH: dir });
  const calls = await readFile(log, "utf8");
  assert.doesNotMatch(calls, /^upgrade uv$/m, "no per-entry upgrade against a tap that did not refresh");
  assert.match(r.stderr, /skipped, brew update failed above/);
  assert.equal(r.code, 2);
});
