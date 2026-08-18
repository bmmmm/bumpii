// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgs } from "../src/cli.ts";
import { brewJsonMany, discoverFormula, installedFormulae } from "../src/discover.ts";
import { stripAnsi } from "../src/exec.ts";
import { sourceFromUrls } from "../src/sources.ts";

test("sourceFromUrls maps the shorthand forges", () => {
  assert.equal(
    sourceFromUrls(["https://github.com/cli/cli/archive/refs/tags/v2.96.0.tar.gz"]),
    "github:cli/cli",
  );
  // codeberg is .org, not .com — the first version of this regex assumed .com
  // and silently failed on exactly the two Forgejo tools it was written for.
  assert.equal(
    sourceFromUrls(["https://codeberg.org/forgejo-contrib/forgejo-cli/archive/v0.6.0.tar.gz"]),
    "codeberg:forgejo-contrib/forgejo-cli",
  );
});

test("sourceFromUrls keeps other Gitea/Forgejo hosts as full URLs", () => {
  // gitea.com serves the same /api/v1 shape, so the URL form is enough.
  assert.equal(
    sourceFromUrls(["https://gitea.com/gitea/tea/archive/v0.14.2.tar.gz"]),
    "https://gitea.com/gitea/tea",
  );
});

test("sourceFromUrls falls through the list to a usable url", () => {
  assert.equal(
    sourceFromUrls(["https://example.com/tarballs/foo.tar.gz", "", "https://github.com/o/r"]),
    "github:o/r",
  );
});

test("sourceFromUrls returns null rather than a wrong guess", () => {
  assert.equal(sourceFromUrls(["https://ftp.gnu.org/gnu/wget/wget-1.25.tar.gz"]), null);
  assert.equal(sourceFromUrls([""]), null);
});

test("stripAnsi removes SGR colour so a version regex stays portable", () => {
  // Real `tea --version` output: the number arrives bold.
  assert.equal(stripAnsi("Version: \x1b[1m0.14.2\x1b[0m\tgolang: 1.26.4"), "Version: 0.14.2\tgolang: 1.26.4");
  assert.equal(stripAnsi("gh version 2.96.0"), "gh version 2.96.0");
});

test("parseArgs routes the subcommands and collects positionals", () => {
  const add = parseArgs(["add", "tea", "gitleaks", "--dry-run"]);
  assert.equal(add.cmd, "add");
  assert.deepEqual(add.rest, ["tea", "gitleaks"]);
  assert.equal(add.dryRun, true);

  assert.equal(parseArgs(["scan"]).cmd, "scan");
  assert.equal(parseArgs(["init"]).cmd, "init");
});

test("parseArgs treats a subcommand-looking positional as an argument", () => {
  // A formula genuinely called "scan" must not re-route the command.
  const a = parseArgs(["add", "scan"]);
  assert.equal(a.cmd, "add");
  assert.deepEqual(a.rest, ["scan"]);
});

// ── brew's install receipts ──────────────────────────────────────────────────
// `scan --new` and `scan --unref` both read them, and a receipt is the kind of
// data that is easy to misread quietly: the array holds every kept version,
// and the fields it does not carry are the ones the report must not invent.

let brewDir: string | null = null;
const realPath = process.env.PATH;
const probeDirs: string[] = [];

async function stubBrew(json: unknown): Promise<void> {
  brewDir ??= await mkdtemp(join(tmpdir(), "bumpii-brew-"));
  const p = join(brewDir, "brew");
  // printf rather than a here-document: sh backs one with a temp file, which a
  // sandboxed run may refuse — surfacing as "brew info failed" rather than as
  // the environment problem it is.
  await writeFile(p, `#!/bin/sh\nprintf '%s' '${JSON.stringify(json)}'\n`);
  await chmod(p, 0o755);
  process.env.PATH = `${brewDir}:${realPath}`;
}

/** A brew that refuses the batch the way the real one does: no stdout, exit 1. */
async function stubFailingBrew(): Promise<void> {
  brewDir ??= await mkdtemp(join(tmpdir(), "bumpii-brew-"));
  const p = join(brewDir, "brew");
  await writeFile(p, "#!/bin/sh\necho 'Error: No available formula' >&2\nexit 1\n");
  await chmod(p, 0o755);
  process.env.PATH = `${brewDir}:${realPath}`;
}

after(async () => {
  process.env.PATH = realPath;
  if (brewDir) await rm(brewDir, { recursive: true, force: true });
  await Promise.all(probeDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("installedFormulae reads the version, time and why of each install", async () => {
  await stubBrew({
    formulae: [
      { name: "gh", installed: [{ version: "2.96.0", time: 1_750_000_000, installed_on_request: true }] },
      {
        name: "libpng",
        installed: [{ version: "1.6.44", time: 1_750_000_001, installed_on_request: false }],
      },
    ],
  });
  const all = await installedFormulae();
  assert.deepEqual(
    all.map((f) => [f.name, f.version, f.onRequest]),
    [
      ["gh", "2.96.0", true],
      ["libpng", "1.6.44", false],
    ],
  );
  assert.equal(all[0]?.installedAt, 1_750_000_000);
});

test("installedFormulae takes the current install, not the oldest kept one", async () => {
  // brew keeps a receipt per kept version. Reading the first would date a
  // formula by an install it has since replaced, and `--new` would then miss
  // exactly the upgrade the window was asking about.
  await stubBrew({
    formulae: [
      {
        name: "node",
        installed: [
          { version: "24.0.0", time: 1_700_000_000, installed_on_request: true },
          { version: "26.5.0", time: 1_780_000_000, installed_on_request: true },
        ],
      },
    ],
  });
  const [node] = await installedFormulae();
  assert.equal(node?.version, "26.5.0");
  assert.equal(node?.installedAt, 1_780_000_000);
});

test("a receipt without a time is kept, with no time invented for it", async () => {
  // Dropping it would understate `--unref`, which is about what is on the
  // machine; making a time up would put it into a `--new` window it never
  // belonged to.
  await stubBrew({ formulae: [{ name: "ancient", installed: [{ version: "1.0" }] }] });
  const [f] = await installedFormulae();
  assert.equal(f?.installedAt, null);
  assert.equal(f?.onRequest, false, "an absent flag is not a request");
});

test("a formula brew lists without any install receipt is skipped", async () => {
  await stubBrew({ formulae: [{ name: "gh", installed: [] }, { name: "nameless" }] });
  assert.deepEqual(await installedFormulae(), []);
});

// ── one brew for a whole batch ───────────────────────────────────────────────

test("brewJsonMany indexes a tapped formula under both names brew answers to", async () => {
  // Shape captured from `brew info --json=v2 jq jundot/omlx/omlx` on Homebrew
  // 6.0.15: a tapped formula is asked for by its full name and comes back with
  // the short one in `name` and the full one only in `full_name`. Keying on
  // either alone leaves half the batch unfound, and the caller then silently
  // re-fetches every tapped formula it asked for — the saving, undone.
  await stubBrew({
    formulae: [
      { name: "jq", full_name: "jq", versions: { stable: "1.8.2" } },
      { name: "omlx", full_name: "jundot/omlx/omlx", versions: { stable: "0.5.7" } },
    ],
  });
  const got = await brewJsonMany(["jq", "jundot/omlx/omlx"]);
  assert.equal(got.get("jundot/omlx/omlx")?.name, "omlx", "the name it was asked for must resolve");
  assert.equal(got.get("omlx")?.full_name, "jundot/omlx/omlx", "and so must the short one");
  assert.equal(got.get("jq")?.name, "jq");
});

test("brewJsonMany answers empty rather than throwing when brew refuses", async () => {
  // brew fails the whole batch over one unknown name and writes nothing at all.
  // An empty map sends discoverFormula to its own fetch, which raises the error
  // naming the formula; throwing here would take the good names down with it.
  await stubFailingBrew();
  assert.deepEqual(await brewJsonMany(["good", "bogus"]), new Map());
});

test("add probes the installed version, not the one brew is offering", async () => {
  // The whole point of `add` is to track something that has an update waiting,
  // and `scan`/`overview` recommend exactly the outdated names. But the probe
  // was confirmed against `versions.stable` — brew's LATEST — and confirmProbe
  // requires that string to appear verbatim in the binary's output. An
  // installed 0.12.3 can never print 0.12.5, so every outdated formula failed
  // with an error blaming its binaries. Measured on the real thing:
  //   bumpii add uv --dry-run
  //   uv: none of its binaries (uv, uvx) reported version 0.12.5
  const dir = await mkdtemp(join(tmpdir(), "bumpii-add-"));
  probeDirs.push(dir);
  const name = "bumpii-fixture-cli";
  // A brew whose --prefix points at the scratch tree, so binariesOf reads a
  // real opt/<name>/bin the way it does on a machine with Homebrew.
  await writeFile(
    join(dir, "brew"),
    `#!/bin/sh\n[ "$1" = "--prefix" ] && { printf '%s' '${dir}'; exit 0; }\nprintf '%s' '{}'\n`,
  );
  await chmod(join(dir, "brew"), 0o755);
  await mkdir(join(dir, "opt", name, "bin"), { recursive: true });
  const bin = join(dir, "opt", name, "bin", name);
  await writeFile(bin, `#!/bin/sh\necho "${name} 0.12.3"\n`);
  await chmod(bin, 0o755);
  process.env.PATH = `${join(dir, "opt", name, "bin")}:${dir}:${realPath}`;

  const known = new Map<string, Record<string, unknown>>([
    [
      name,
      {
        name,
        full_name: name,
        // brew has 0.12.5 waiting; 0.12.3 is what is on the machine.
        versions: { stable: "0.12.5" },
        installed: [{ version: "0.12.3" }],
        homepage: "https://github.com/owner/app",
      },
    ],
  ]);

  const d = await discoverFormula(name, undefined, known);
  assert.equal(d.version, "0.12.3", "the entry records what is installed, not what is on offer");
  assert.equal(d.binary, name);
  assert.match(d.entry.version.match, /0-9/, "the pattern is built from the line the binary printed");
  // And it still resolves: the generated entry must read the version back out.
  assert.match(`${name} 0.12.3`, new RegExp(d.entry.version.match));
});

test("add says a formula is not installed rather than blaming its binaries", async () => {
  // Nothing installed means there is no binary to probe, so "none of its
  // binaries reported version X" describes a probe that never had a chance.
  const dir = await mkdtemp(join(tmpdir(), "bumpii-add-"));
  probeDirs.push(dir);
  await writeFile(join(dir, "brew"), `#!/bin/sh\nprintf '%s' '${dir}'\n`);
  await chmod(join(dir, "brew"), 0o755);
  process.env.PATH = `${dir}:${realPath}`;

  const known = new Map<string, Record<string, unknown>>([
    [
      "never-installed",
      {
        name: "never-installed",
        versions: { stable: "1.0.0" },
        installed: [],
        homepage: "https://github.com/owner/app",
      },
    ],
  ]);
  await assert.rejects(
    () => discoverFormula("never-installed", undefined, known),
    /not installed/,
    "the reason has to name the actual state, not the probe",
  );
});
