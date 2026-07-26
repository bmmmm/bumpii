// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { addTools, initConfig, loadConfig, configPath } from "./config.ts";
import { discoverFormula, untrackedFormulae } from "./discover.ts";
import { digest, resolveEngine } from "./judge.ts";
import { listReleases, parseSource } from "./sources.ts";
import { renderReport } from "./render.ts";
import type { ToolReport } from "./types.ts";
import { findUsage } from "./usage.ts";
import { installedVersion, releasesBehind } from "./version.ts";

const run = promisify(execFile);

const HELP = `bumpii — what changed in the CLIs you use, judged against your own usage

  bumpii [options]        digest pending releases for every configured tool
  bumpii init             write a starter config
  bumpii add <formula>…   derive entries from installed Homebrew formulae
  bumpii scan             list installed formulae not yet tracked
  bumpii --yes            digest, then run each tool's update command

Options:
  --only <name,...>   restrict to these tools
  --model <id>        force a judge model instead of discovering one
  --json              machine-readable report
  --no-judge          skip the model; list pending releases and their URLs
  --dry-run           with add: show the entries, write nothing
  -h, --help

Config: ${configPath()}
Engine: OPENAI_BASE_URL (oMLX/Ollama/vLLM) is preferred, else the \`claude\` CLI.
`;

interface Args {
  cmd: "digest" | "init" | "add" | "scan" | "help";
  yes: boolean;
  json: boolean;
  noJudge: boolean;
  dryRun: boolean;
  only: string[];
  /** Positional arguments after a subcommand, e.g. formula names for `add`. */
  rest: string[];
  model?: string;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: "digest",
    yes: false,
    json: false,
    noJudge: false,
    dryRun: false,
    only: [],
    rest: [],
  };
  let sawCmd = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === undefined) continue;
    if (!sawCmd && (v === "init" || v === "add" || v === "scan")) {
      a.cmd = v;
      sawCmd = true;
    } else if (v === "-h" || v === "--help") a.cmd = "help";
    else if (v === "--yes" || v === "-y") a.yes = true;
    else if (v === "--json") a.json = true;
    else if (v === "--no-judge") a.noJudge = true;
    else if (v === "--dry-run" || v === "-n") a.dryRun = true;
    else if (v === "--only") a.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (v === "--model") a.model = argv[++i];
    else if (v.startsWith("-")) throw new Error(`unknown option: ${v}`);
    else a.rest.push(v);
  }
  return a;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.cmd === "init") {
    const { path, created } = await initConfig();
    process.stdout.write(created ? `wrote ${path}\n` : `already exists: ${path}\n`);
    return 0;
  }

  if (args.cmd === "scan") {
    const cfg = await loadConfig();
    // Key by the formula each entry upgrades, not by its binary name.
    const tracked = new Set(
      cfg.tools.flatMap((t) => {
        const m = /brew\s+(?:upgrade|install)\s+(\S+)/.exec(t.update);
        return m?.[1] ? [t.name, m[1]] : [t.name];
      }),
    );
    const untracked = await untrackedFormulae(tracked);
    if (untracked.length === 0) {
      process.stdout.write("every installed formula is already tracked\n");
      return 0;
    }
    process.stdout.write(
      `${untracked.length} installed formula(e) not tracked:\n  ${untracked.join(" ")}\n\n` +
        `add the ones whose release notes you want:\n  bumpii add ${untracked.slice(0, 4).join(" ")}\n`,
    );
    return 0;
  }

  if (args.cmd === "add") {
    if (args.rest.length === 0) throw new Error("add: name at least one Homebrew formula");
    const found = [];
    for (const formula of args.rest) {
      try {
        const d = await discoverFormula(formula);
        found.push(d);
        process.stdout.write(
          `${d.formula} → ${d.entry.name} ${d.version}\n` +
            `  source: ${d.source}\n` +
            `  probe:  ${d.probe}\n` +
            `  update: ${d.entry.update}\n`,
        );
      } catch (err) {
        // One unresolvable formula must not sink the rest of the batch.
        process.stderr.write(`${(err as Error).message}\n`);
      }
    }
    if (found.length === 0) return 2;
    if (args.dryRun) {
      process.stdout.write("\n--dry-run: nothing written\n");
      return 0;
    }
    const added = await addTools(found.map((d) => d.entry));
    process.stdout.write(
      added.length > 0
        ? `\nadded to ${configPath()}: ${added.join(", ")}\n`
        : `\nnothing added — already tracked\n`,
    );
    return 0;
  }

  const config = await loadConfig();
  const tools = args.only.length
    ? config.tools.filter((t) => args.only.includes(t.name))
    : config.tools;
  if (tools.length === 0) throw new Error(`no tools matched --only ${args.only.join(",")}`);

  const engine = args.noJudge
    ? { kind: "none" as const, model: "", label: "skipped (--no-judge)" }
    : await resolveEngine({ model: args.model });

  // Tools are independent — one unreachable forge should not delay the rest,
  // and must not sink the run either (hence the per-tool error field).
  const reports: ToolReport[] = await Promise.all(
    tools.map(async (tool): Promise<ToolReport> => {
      const base: ToolReport = { tool, installed: null, latest: null, behind: [], items: [], hits: [] };
      try {
        const [installed, releases] = await Promise.all([
          installedVersion(tool),
          listReleases(parseSource(tool.source)),
        ]);
        const behind = releasesBehind(releases, installed);
        const items = await digest(engine, tool.name, behind);
        const hits = await findUsage(config.usagePaths, items.flatMap((i) => i.commands));
        return { ...base, installed, latest: releases[0]?.version ?? null, behind, items, hits };
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ engine: engine.label, reports }, null, 2)}\n`);
  } else {
    process.stdout.write(renderReport(reports, engine.label));
  }

  if (args.yes) {
    for (const r of reports) {
      if (r.error || !r.installed || r.behind.length === 0) continue;
      process.stdout.write(`\n$ ${r.tool.update}\n`);
      try {
        const out = await run("/bin/sh", ["-c", r.tool.update], { timeout: 600_000 });
        process.stdout.write(out.stdout);
      } catch (err) {
        // Keep going: one formula failing to build should not block the others.
        process.stderr.write(`${r.tool.name}: update failed: ${(err as Error).message}\n`);
      }
    }
  }

  // Non-zero when something is pending, so a scheduled run can act on it.
  return reports.some((r) => !r.error && r.behind.length > 0) && !args.yes ? 1 : 0;
}

// Only run when invoked as the entrypoint. Without this guard, importing
// anything from here (the tests import parseArgs) would execute the whole CLI
// and exit the test runner mid-suite.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`bumpii: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    });
}
