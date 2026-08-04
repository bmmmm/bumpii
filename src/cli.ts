// SPDX-License-Identifier: GPL-3.0-or-later
import {
  addTools,
  configPath,
  EDITABLE_FIELDS,
  type EditableField,
  initConfig,
  loadConfig,
  removeTools,
  setToolField,
} from "./config.ts";
import { discoverFormula, untrackedFormulae } from "./discover.ts";
import { run } from "./exec.ts";
import { discoverImage, untrackedContainers } from "./images.ts";
import { digest, resolveEngine } from "./judge.ts";
import { limiter } from "./limit.ts";
import { renderReport } from "./render.ts";
import { listReleases, parseSource } from "./sources.ts";
import type { DigestItem, ToolConfig, ToolReport } from "./types.ts";
import { findUsage, resolveUsagePaths } from "./usage.ts";
import { installedVersion, isTruncated, latestComparable, releasesBehind } from "./version.ts";

/**
 * How many tools' releases may be judged at once.
 *
 * Low enough that a local single-model server (oMLX, Ollama) is not asked to
 * hold this many requests in flight at once, high enough that a hosted engine
 * still overlaps several tools instead of running the whole digest serially.
 */
const JUDGE_CONCURRENCY = 3;

const HELP = `bumpii — what changed in the CLIs and containers you run, judged against your usage

  bumpii [options]        digest pending releases for every configured tool
  bumpii init             write a starter config
  bumpii add <formula>…   derive entries from installed Homebrew formulae
  bumpii add --image <c>… derive entries from running containers
  bumpii list             what is tracked, and what is still incomplete
  bumpii set <n> <f> <v>  change one field: source or update
  bumpii rm <name>…       stop tracking these
  bumpii scan             list installed formulae not yet tracked
  bumpii scan --image     list running containers not yet tracked
  bumpii --yes            digest, then run each tool's update command

Options:
  --image             with add: read the arguments as container names
                      with scan: list containers instead of formulae
  --source <s>        with add: set the repo yourself, for one tool at a time
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
  cmd: "digest" | "init" | "add" | "scan" | "list" | "set" | "rm" | "help";
  yes: boolean;
  json: boolean;
  noJudge: boolean;
  dryRun: boolean;
  /** With `add`: the positionals are container names, not brew formulae. */
  image: boolean;
  /** With `add`: the repo, when the image does not state it. One tool only. */
  source?: string;
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
    image: false,
    only: [],
    rest: [],
  };
  let sawCmd = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === undefined) continue;
    if (
      !sawCmd &&
      (v === "init" || v === "add" || v === "scan" || v === "list" || v === "set" || v === "rm")
    ) {
      a.cmd = v;
      sawCmd = true;
    } else if (v === "-h" || v === "--help") a.cmd = "help";
    else if (v === "--yes" || v === "-y") a.yes = true;
    else if (v === "--json") a.json = true;
    else if (v === "--no-judge") a.noJudge = true;
    else if (v === "--dry-run" || v === "-n") a.dryRun = true;
    else if (v === "--image") a.image = true;
    else if (v === "--source") a.source = takeValue(argv, ++i, v);
    else if (v === "--only") a.only = takeValue(argv, ++i, v).split(",").filter(Boolean);
    else if (v === "--model") a.model = takeValue(argv, ++i, v);
    else if (v.startsWith("-")) throw new Error(`unknown option: ${v}`);
    else a.rest.push(v);
  }
  return a;
}

/**
 * The Homebrew formula an update command upgrades, if it is one.
 *
 * Options are skipped rather than taken as the first word after the
 * subcommand: `brew upgrade --fetch-HEAD gh` upgrades gh, and reading
 * "--fetch-HEAD" as the formula made `scan` keep offering a tool that was
 * already tracked. Returns an empty list for anything that is not a brew
 * command, so callers can spread it.
 */
export function formulaOf(update: string): string[] {
  const m = /brew\s+(?:upgrade|install)\s+(.+)/.exec(update);
  if (!m?.[1]) return [];
  const formula = m[1].split(/\s+/).find((word) => word && !word.startsWith("-"));
  return formula ? [formula] : [];
}

/**
 * Whether an update line is still the placeholder `add --image` writes.
 *
 * It matters that this is not just skipped: `sh -c` runs a comment happily and
 * exits 0, so an unfinished entry would report a successful update that never
 * happened — and `--yes` would exit 0 with it.
 */
export function isPlaceholderUpdate(update: string): boolean {
  return update.trim().startsWith("#");
}

/**
 * The container an entry reads its version out of, if it reads one.
 *
 * `scan --image` needs this for the same reason the brew path needs
 * `formulaOf`: the config key is whatever `add --image` was given, and an
 * entry renamed by hand would otherwise have its container offered again as
 * untracked. The name sits at the end of the argv `add --image` writes
 * (`podman inspect --format <template> <container>`), which is also where both
 * runtimes expect it. Returns an empty list for entries that are not container
 * probes, so callers can spread it.
 */
export function containerOf(tool: ToolConfig): string[] {
  const cmd = tool.version.cmd;
  if ((cmd[0] !== "podman" && cmd[0] !== "docker") || cmd[1] !== "inspect") return [];
  const target = cmd.at(-1);
  // A bare `inspect --format <template>` names no container; taking the
  // template for one would track a Go expression and stop offering nothing.
  return target && !target.startsWith("{{") ? [target] : [];
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

  if (args.cmd === "list") {
    const cfg = await loadConfig();
    if (cfg.tools.length === 0) {
      process.stdout.write(`nothing tracked in ${configPath()} — try 'bumpii add' or 'bumpii scan'\n`);
      return 0;
    }
    // The gaps are the point of this command: an entry can be written without
    // a source or with an unfinished update line, and both are invisible until
    // something goes wrong with them.
    let gaps = 0;
    for (const t of cfg.tools) {
      const missing: string[] = [];
      if (!t.source) missing.push("source");
      if (isPlaceholderUpdate(t.update)) missing.push("update");
      if (missing.length > 0) gaps++;
      process.stdout.write(
        `${t.name.padEnd(20)} ${(t.source || "—").padEnd(38)}` +
          `${missing.length > 0 ? `needs: ${missing.join(", ")}` : ""}\n`,
      );
    }
    if (gaps > 0) {
      process.stdout.write(
        `\n${gaps} entr${gaps === 1 ? "y" : "ies"} incomplete — bumpii set <name> <field> <value>\n`,
      );
    }
    return 0;
  }

  if (args.cmd === "set") {
    const [name, field, ...valueParts] = args.rest;
    const value = valueParts.join(" ");
    if (!name || !field || !value) {
      throw new Error(
        `set needs a tool, a field and a value: bumpii set <name> <${EDITABLE_FIELDS.join("|")}> <value>`,
      );
    }
    if (!(EDITABLE_FIELDS as readonly string[]).includes(field)) {
      // version.cmd is argv and version.match is a regex; setting either from
      // a single string argument would be a way to write a broken entry more
      // conveniently than editing the file.
      throw new Error(
        `cannot set "${field}" — only ${EDITABLE_FIELDS.join(" and ")} are settable here; edit ${configPath()} for the rest`,
      );
    }
    await setToolField(name, field as EditableField, value);
    process.stdout.write(`${name}: ${field} = ${value}\n`);
    return 0;
  }

  if (args.cmd === "rm") {
    if (args.rest.length === 0) throw new Error("rm: name at least one tool — see 'bumpii list'");
    const removed = await removeTools(args.rest);
    if (removed.length === 0) {
      // Saying nothing here would read as success and leave a typo in place.
      throw new Error(`none of those are tracked: ${args.rest.join(", ")} — see 'bumpii list'`);
    }
    process.stdout.write(`no longer tracked: ${removed.join(", ")}\n`);
    const missed = args.rest.filter((n) => !removed.includes(n));
    if (missed.length > 0) process.stderr.write(`not tracked, ignored: ${missed.join(", ")}\n`);
    return 0;
  }

  if (args.cmd === "scan" && args.image) {
    const cfg = await loadConfig();
    // Key by every name an entry answers to: the config key, plus the container
    // its version probe inspects — those differ once an entry is renamed.
    const tracked = new Set(cfg.tools.flatMap((t) => [t.name, ...containerOf(t)]));
    const { runtime, running, untracked } = await untrackedContainers(tracked);
    if (running === 0) {
      // Not the same answer as "all tracked", and saying so names the runtime
      // that was asked — the machine may well have containers under the other.
      process.stdout.write(`no containers are running (${runtime})\n`);
      return 0;
    }
    if (untracked.length === 0) {
      process.stdout.write(`every running container is already tracked (${runtime})\n`);
      return 0;
    }
    const width = Math.max(...untracked.map((c) => c.name.length));
    const suggest = untracked.slice(0, 4).map((c) => c.name);
    process.stdout.write(
      `${untracked.length} running container(s) not tracked (${runtime}):\n` +
        untracked.map((c) => `  ${c.name.padEnd(width)}  ${c.image}\n`).join("") +
        `\nadd the ones whose release notes you want:\n` +
        `  bumpii add --image ${suggest.join(" ")}\n`,
    );
    return 0;
  }

  if (args.cmd === "scan") {
    const cfg = await loadConfig();
    // Key by the formula each entry upgrades, not by its binary name.
    const tracked = new Set(cfg.tools.flatMap((t) => [t.name, ...formulaOf(t.update)]));
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
    if (args.rest.length === 0) {
      throw new Error(
        args.image
          ? "add --image: name at least one running container"
          : "add: name at least one Homebrew formula (or use --image for containers)",
      );
    }
    // One source cannot be right for several tools, and applying it to all of
    // them would attach one repo's release notes to every one of them.
    if (args.source && args.rest.length > 1) {
      throw new Error(
        `--source names one repo, but ${args.rest.length} tools were given — add them one at a time`,
      );
    }
    if (args.source && !args.image) {
      throw new Error("--source only applies to --image; a formula's repo comes from brew");
    }

    // Concurrently: each entry costs an inspect or a brew call, and on the
    // brew path up to five version probes able to sit out their own timeout.
    const settled = await Promise.all(
      args.rest.map(async (name) => {
        try {
          // One unresolvable name must not sink the rest of the batch.
          const d = args.image ? await discoverImage(name) : await discoverFormula(name);
          return { ok: true as const, value: d };
        } catch (err) {
          return { ok: false as const, message: (err as Error).message };
        }
      }),
    );
    const found = [];
    let incomplete = 0;
    // Reported in the order they were asked for, not the order they finished.
    for (const r of settled) {
      if (!r.ok) {
        process.stderr.write(`${r.message}\n`);
        continue;
      }
      const d = r.value;
      const from = "formula" in d ? d.formula : `${d.container} (${d.runtime})`;
      const how = "probe" in d ? d.probe : `image ${d.image}`;

      // --source supplies what the image did not state. Written in as given,
      // so a wrong one is visibly the caller's choice rather than a guess.
      if (args.source && "needsSource" in d && d.needsSource) d.entry.source = args.source;
      if (!d.entry.source) incomplete++;

      found.push(d);
      process.stdout.write(
        `${from} → ${d.entry.name} ${d.version}\n` +
          `  source: ${d.entry.source || "(not stated by the image — fill it in)"}\n` +
          `  probe:  ${how}\n` +
          `  update: ${d.entry.update}\n`,
      );
    }

    // Written even without a source: everything else about the entry is
    // worked out, so it is one line away from working, and an entry sitting
    // in the config with a visible gap beats a JSON block scrolled off the
    // terminal. The digest reports it as needing a source rather than failing.
    if (incomplete > 0) {
      process.stdout.write(
        `\n${incomplete} entr${incomplete === 1 ? "y is" : "ies are"} missing a "source" — ` +
          `the image did not say which repo it was built from, and bumpii will not guess\n` +
          `(ghcr.io/home-assistant/home-assistant is built from github.com/home-assistant/core: a guess\n` +
          `off the image path lands on a real but different repo). Set it in ${configPath()},\n` +
          `or re-run with --source github:owner/repo for a single container.\n`,
      );
    }

    if (found.length === 0) return 2;
    // A container entry cannot have its update command guessed — pulling is
    // only half of it — so say so once rather than letting `--yes` later run
    // a comment.
    if (found.some((d) => isPlaceholderUpdate(d.entry.update))) {
      process.stdout.write(
        `\nfinish the "update" line for the container entries in ${configPath()} before using --yes\n`,
      );
    }
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
  if (tools.length === 0)
    throw new Error(`no tools matched --only ${args.only.join(",")} — see 'bumpii list' for the names`);

  const engine = args.noJudge
    ? { kind: "none" as const, model: "", label: "skipped (--no-judge)" }
    : await resolveEngine({ model: args.model });

  // Resolved once, not per tool: a usage path that does not exist would make
  // every grep come back empty and every tool report "affects you: none".
  const usage = await resolveUsagePaths(config.usagePaths);

  // Fetching stays fully concurrent — it is a GET per tool, and the forges
  // rate-limit that themselves. Judging does not: a stampede of concurrent
  // calls at a local single-model server (the OpenAI-compatible path this
  // tool prefers) queues inside the server rather than in this process, each
  // one still burning its own 180s timeout while it waits its turn.
  const limitJudge = limiter(JUDGE_CONCURRENCY);

  // Tools are independent — one unreachable forge should not delay the rest,
  // and must not sink the run either (hence the per-tool error field).
  const reports: ToolReport[] = await Promise.all(
    tools.map(async (tool): Promise<ToolReport> => {
      const base: ToolReport = { tool, installed: null, latest: null, behind: [], items: [], hits: [] };
      // No source means there is nothing to ask, so no forge is contacted and
      // no version probed — render.ts reports it as waiting for one line.
      if (!tool.source) return base;
      try {
        const [installed, list] = await Promise.all([
          installedVersion(tool),
          listReleases(parseSource(tool.source)),
        ]);
        const behind = releasesBehind(list.releases, installed);

        // Digesting is fallible in a way fetching is not — a small local model
        // returning prose instead of JSON is routine. Catching it here keeps
        // the releases we already have, so the report degrades to their URLs
        // instead of throwing the news away along with the summary.
        let items: DigestItem[] = [];
        let digestError: string | undefined;
        try {
          items = await limitJudge(() => digest(engine, tool.name, behind));
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
          latest: latestComparable(list.releases),
          behind,
          truncated: isTruncated(list.releases, behind, list.capped),
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
    // The whole engine, not just its label: a scheduled run that acts on this
    // should be able to branch on "was anything actually judged" without
    // parsing prose.
    process.stdout.write(
      `${JSON.stringify({ engine, missingUsagePaths: usage.missing, reports }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(renderReport(reports, { engine, missingPaths: usage.missing }));
  }

  let updateFailures = 0;
  if (args.yes) {
    for (const r of reports) {
      if (r.error || !r.installed || r.behind.length === 0) continue;
      // A placeholder update line is a comment, which `sh -c` runs happily and
      // exits 0 on — reporting a successful update that never happened. That
      // is the exact class of quiet wrong answer this tool exists to avoid.
      if (isPlaceholderUpdate(r.tool.update)) {
        updateFailures++;
        process.stderr.write(
          `${r.tool.name}: update line is still a placeholder (${r.tool.update.trim()}) — skipped\n`,
        );
        continue;
      }
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
