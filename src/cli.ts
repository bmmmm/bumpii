// SPDX-License-Identifier: GPL-3.0-or-later
import { addTools, configPath, initConfig, loadConfig } from "./config.ts";
import { discoverFormula, untrackedFormulae } from "./discover.ts";
import { run } from "./exec.ts";
import { digest, resolveEngine } from "./judge.ts";
import { renderReport } from "./render.ts";
import { listReleases, parseSource } from "./sources.ts";
import type { DigestItem, ToolReport } from "./types.ts";
import { findUsage, resolveUsagePaths } from "./usage.ts";
import { installedVersion, latestComparable, releasesBehind } from "./version.ts";

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

/**
 * Read the value belonging to an option, refusing to swallow the next flag.
 * `bumpii --model --json` used to set the model to "--json" and quietly drop
 * the flag that was meant to change the output.
 */
function takeValue(argv: string[], i: number, opt: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("-")) throw new Error(`${opt} needs a value`);
  return v;
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
    else if (v === "--only") a.only = takeValue(argv, ++i, v).split(",").filter(Boolean);
    else if (v === "--model") a.model = takeValue(argv, ++i, v);
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
    // Concurrently: each formula costs a brew call plus up to five version
    // probes, every one of them able to sit out its own timeout.
    const settled = await Promise.all(
      args.rest.map(async (formula) => {
        try {
          // One unresolvable formula must not sink the rest of the batch.
          return { ok: true as const, value: await discoverFormula(formula) };
        } catch (err) {
          return { ok: false as const, message: (err as Error).message };
        }
      }),
    );
    const found = [];
    // Reported in the order they were asked for, not the order they finished.
    for (const r of settled) {
      if (!r.ok) {
        process.stderr.write(`${r.message}\n`);
        continue;
      }
      const d = r.value;
      found.push(d);
      process.stdout.write(
        `${d.formula} → ${d.entry.name} ${d.version}\n` +
          `  source: ${d.source}\n` +
          `  probe:  ${d.probe}\n` +
          `  update: ${d.entry.update}\n`,
      );
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
  const tools = args.only.length ? config.tools.filter((t) => args.only.includes(t.name)) : config.tools;
  if (tools.length === 0) throw new Error(`no tools matched --only ${args.only.join(",")}`);

  const engine = args.noJudge
    ? { kind: "none" as const, model: "", label: "skipped (--no-judge)" }
    : await resolveEngine({ model: args.model });

  // Resolved once, not per tool: a usage path that does not exist would make
  // every grep come back empty and every tool report "affects you: none".
  const usage = await resolveUsagePaths(config.usagePaths);

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

        // Digesting is fallible in a way fetching is not — a small local model
        // returning prose instead of JSON is routine. Catching it here keeps
        // the releases we already have, so the report degrades to their URLs
        // instead of throwing the news away along with the summary.
        let items: DigestItem[] = [];
        let digestError: string | undefined;
        try {
          items = await digest(engine, tool.name, behind);
        } catch (err) {
          digestError = err instanceof Error ? err.message : String(err);
        }

        const hits = await findUsage(
          usage.roots,
          items.flatMap((i) => i.commands),
        );
        return {
          ...base,
          installed,
          latest: latestComparable(releases),
          behind,
          items,
          hits,
          digestError,
        };
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ engine: engine.label, missingUsagePaths: usage.missing, reports }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(renderReport(reports, { engine, missingPaths: usage.missing }));
  }

  let updateFailures = 0;
  if (args.yes) {
    for (const r of reports) {
      if (r.error || !r.installed || r.behind.length === 0) continue;
      process.stdout.write(`\n$ ${r.tool.update}\n`);
      try {
        const out = await run("/bin/sh", ["-c", r.tool.update], { timeout: 600_000 });
        process.stdout.write(out.stdout);
      } catch (err) {
        // Keep going: one formula failing to build should not block the others.
        updateFailures++;
        process.stderr.write(`${r.tool.name}: update failed: ${(err as Error).message}\n`);
      }
    }
  }

  // An unattended --yes run has to be able to say it did not work; reporting
  // success while a formula failed to build is how a broken cron goes unseen.
  if (args.yes) return updateFailures > 0 ? 2 : 0;
  // Non-zero when something is pending, so a scheduled run can act on it.
  return reports.some((r) => !r.error && r.behind.length > 0) ? 1 : 0;
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
