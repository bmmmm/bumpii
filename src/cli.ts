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
import { binariesOf, discoverFormula, installedFormulae, leaves, untrackedFormulae } from "./discover.ts";
import { run } from "./exec.ts";
import { discoverImage, untrackedContainers } from "./images.ts";
import { digest, resolveEngine } from "./judge.ts";
import { limiter } from "./limit.ts";
import { buildOverview } from "./overview.ts";
import { renderOverview, renderReport } from "./render.ts";
import { listReleases, parseSource } from "./sources.ts";
import type { DigestItem, ToolConfig, ToolReport } from "./types.ts";
import { findUsage, mentioned, resolveUsagePaths } from "./usage.ts";
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
  bumpii overview         everything brew has pending, ranked by your own usage
  bumpii init             write a starter config
  bumpii add <formula>…   derive entries from installed Homebrew formulae
  bumpii add --image <c>… derive entries from running containers
  bumpii list             what is tracked, and what is still incomplete
  bumpii set <n> <f> <v>  change one field: source or update
  bumpii rm <name>…       stop tracking these
  bumpii scan             list installed formulae not yet tracked
  bumpii scan --image     list running containers not yet tracked
  bumpii scan --new       list what was installed recently
  bumpii scan --unref     list formulae no file of yours names
  bumpii --yes            digest, then run each tool's update command

Options:
  --image             with add: read the arguments as container names
                      with scan: list containers instead of formulae
  --new               with scan: what arrived recently, not what is untracked
  --unref             with scan: leaves nothing in usagePaths mentions
  --since <14d|3w>    with scan --new: how far back to look (default 14d)
  --deps              with scan --new: list dependencies too, not just requests
  --source <s>        with add: set the repo yourself, for one tool at a time
                      (needed when brew's URLs name no forge, as for node)
  --only <name,...>   restrict to these tools, or with overview these packages
  --model <id>        force a judge model instead of discovering one
  --json              machine-readable report
  --no-judge          skip the model; list pending releases and their URLs
  --dry-run           with add: show the entries, write nothing
  -h, --help

Config: ${configPath()}
Engine: OPENAI_BASE_URL (oMLX/Ollama/vLLM) is preferred, else the \`claude\` CLI.
`;

interface Args {
  cmd: "digest" | "overview" | "init" | "add" | "scan" | "list" | "set" | "rm" | "help";
  yes: boolean;
  json: boolean;
  noJudge: boolean;
  dryRun: boolean;
  /** With `add`: the positionals are container names, not brew formulae. */
  image: boolean;
  /** With `scan`: what showed up recently, rather than what is untracked. */
  onlyNew: boolean;
  /** With `scan`: leaves that no file in usagePaths names. */
  unreferenced: boolean;
  /** With `scan --new`: how far back "recently" reaches, in days. */
  sinceDays: number;
  /** With `scan --new`: list the dependencies too, not only what you asked for. */
  deps: boolean;
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

/** The default window for `scan --new`, in days. */
const SINCE_DEFAULT = 14;

/**
 * Read a window like "14d", "3w" or a bare number of days.
 *
 * Deliberately a duration rather than a stored "last run" timestamp: nothing
 * else in this tool keeps state, and a remembered timestamp would make the
 * same command answer differently depending on whether an earlier run was
 * interrupted — with no way to see that from the output.
 */
export function parseWindow(spec: string): number {
  const m = /^([0-9]+)\s*([dw])?$/.exec(spec.trim());
  const n = m?.[1] ? Number.parseInt(m[1], 10) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--since takes a positive window like 14d, 3w or 30 (days) — got "${spec}"`);
  }
  return m?.[2] === "w" ? n * 7 : n;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: "digest",
    yes: false,
    json: false,
    noJudge: false,
    dryRun: false,
    image: false,
    onlyNew: false,
    unreferenced: false,
    sinceDays: SINCE_DEFAULT,
    deps: false,
    only: [],
    rest: [],
  };
  let sawCmd = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === undefined) continue;
    if (
      !sawCmd &&
      (v === "init" ||
        v === "add" ||
        v === "scan" ||
        v === "list" ||
        v === "set" ||
        v === "rm" ||
        v === "overview")
    ) {
      a.cmd = v;
      sawCmd = true;
    } else if (v === "-h" || v === "--help") a.cmd = "help";
    else if (v === "--yes" || v === "-y") a.yes = true;
    else if (v === "--json") a.json = true;
    else if (v === "--no-judge") a.noJudge = true;
    else if (v === "--dry-run" || v === "-n") a.dryRun = true;
    else if (v === "--image") a.image = true;
    else if (v === "--new") a.onlyNew = true;
    else if (v === "--unref") a.unreferenced = true;
    else if (v === "--deps") a.deps = true;
    else if (v === "--since") a.sinceDays = parseWindow(takeValue(argv, ++i, v));
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

  if (args.cmd === "scan") {
    // Each asks a different question of a different source; running two at
    // once would print two reports under one heading.
    const modes = [args.image && "--image", args.onlyNew && "--new", args.unreferenced && "--unref"].filter(
      (m): m is string => typeof m === "string",
    );
    if (modes.length > 1) {
      throw new Error(`scan takes one of --image, --new or --unref at a time — got ${modes.join(" ")}`);
    }
  }

  if (args.cmd === "scan" && args.onlyNew) {
    const cfg = await loadConfig();
    const cutoff = Date.now() / 1000 - args.sinceDays * 86_400;
    const fresh = (await installedFormulae())
      .filter((f) => f.installedAt !== null && f.installedAt >= cutoff)
      .sort((a, b) => (b.installedAt ?? 0) - (a.installedAt ?? 0));

    if (fresh.length === 0) {
      process.stdout.write(
        `nothing installed in the last ${args.sinceDays} days — --since 90d to widen the window\n`,
      );
      return 0;
    }

    // Split on brew's own record of why each formula is here. A single
    // `brew install php@8.1` drags in seventy dependencies, and listing them
    // all buries the one line that answers the question — measured on a real
    // machine: 77 formulae in the window, 76 of them dependencies.
    const requested = fresh.filter((f) => f.onRequest);
    const deps = fresh.filter((f) => !f.onRequest);
    const shown = args.deps ? fresh : requested;
    const depNote =
      deps.length > 0 && !args.deps
        ? `\n${deps.length} dependenc${deps.length === 1 ? "y" : "ies"} came in behind them — --deps to list those too\n`
        : "";

    if (shown.length === 0) {
      process.stdout.write(
        `nothing you asked for in the last ${args.sinceDays} days${depNote || "\n"}`.replace(/^\n/, ""),
      );
      return 0;
    }

    const width = Math.max(...shown.map((f) => f.name.length));
    const vWidth = Math.max(...shown.map((f) => f.version.length));
    process.stdout.write(
      `${shown.length} formula(e) ${args.deps ? "" : "you asked for, "}installed or upgraded in the last ${args.sinceDays} days:\n` +
        shown
          .map((f) => {
            const when = new Date((f.installedAt ?? 0) * 1000).toISOString().slice(0, 10);
            // The reason column only carries information when both kinds are
            // on screen; without --deps every row would read "requested".
            const why = args.deps ? `  ${f.onRequest ? "requested" : "dependency"}` : "";
            return `  ${f.name.padEnd(width)}  ${f.version.padEnd(vWidth)}  ${when}${why}\n`;
          })
          .join("") +
        depNote,
    );

    // brew keeps one time per install and an upgrade overwrites it, so a
    // formula you have had for years reads the same as one that arrived
    // yesterday. Said out loud rather than papered over: "new" is what this
    // data can support, and claiming a first-install date it does not hold
    // would be the same kind of quiet wrong answer as a guessed repo.
    process.stdout.write(
      `\nbrew records one time per install, so an upgrade is indistinguishable from a\n` +
        `first install — this is what changed on the machine, not what is new to it.\n`,
    );

    // Which of them you could start reading release notes for — the same
    // formula-keyed match `scan` uses, so an entry already tracked under a
    // different binary name is not offered again. Dependencies are never
    // offered: nobody wants a digest of libpng's release notes.
    const tracked = new Set(cfg.tools.flatMap((t) => [t.name, ...formulaOf(t.update)]));
    const addable = requested.filter((f) => !tracked.has(f.name)).map((f) => f.name);
    if (addable.length > 0) {
      process.stdout.write(`\nnot tracked yet:\n  bumpii add ${addable.slice(0, 4).join(" ")}\n`);
    }
    return 0;
  }

  if (args.cmd === "scan" && args.unreferenced) {
    const cfg = await loadConfig();
    const usage = await resolveUsagePaths(cfg.usagePaths);
    if (usage.roots.length === 0) {
      // With nothing to search, every formula comes back unreferenced — the
      // confident wrong answer this command is built not to give.
      throw new Error(
        cfg.usagePaths.length === 0
          ? `no usagePaths in ${configPath()} — there is nothing to search, so "nothing names it" would be true of everything`
          : `none of the usagePaths exist (${usage.missing.join(", ")}) — every formula would read as unreferenced`,
      );
    }

    const leafNames = await leaves();
    const receipts = new Map((await installedFormulae()).map((f) => [f.name, f]));
    // A formula is often not called by its own name — forgejo-cli ships `fj` —
    // so the binaries it installs are searched for too. Grepping the formula
    // name alone would report it as unmentioned while every script calls it.
    const candidates = await Promise.all(
      leafNames.map(async (formula) => {
        const short = formula.split("/").pop() ?? formula;
        return { formula, needles: [...new Set([formula, short, ...(await binariesOf(short))])] };
      }),
    );
    const found = await mentioned(usage.roots, [...new Set(candidates.flatMap((c) => c.needles))]);
    const unref = candidates.filter((c) => !c.needles.some((n) => found.has(n)));

    if (unref.length === 0) {
      process.stdout.write(`every one of the ${leafNames.length} leaves is named somewhere in your files\n`);
      return 0;
    }
    const width = Math.max(...unref.map((c) => c.formula.length));
    process.stdout.write(
      `${unref.length} of ${leafNames.length} leaves are named in nothing you wrote:\n` +
        unref
          .map(
            (c) =>
              `  ${c.formula.padEnd(width)}  ${receipts.get(c.formula)?.onRequest ? "requested" : "dependency"}\n`,
          )
          .join("") +
        `\nsearched: ${cfg.usagePaths.join(" ")}\n` +
        `this is not "you never use it" — only that no file in those paths names it,\n` +
        `and nothing here can see an interactive shell. A leaf marked "dependency"\n` +
        `came in behind something else and now has nothing depending on it.\n`,
    );
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

    // Concurrently: each entry costs an inspect or a brew call, and on the
    // brew path up to five version probes able to sit out their own timeout.
    const settled = await Promise.all(
      args.rest.map(async (name) => {
        try {
          // One unresolvable name must not sink the rest of the batch.
          const d = args.image ? await discoverImage(name) : await discoverFormula(name, args.source);
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

  if (args.cmd === "overview") {
    const config = await loadConfig();
    // Positionals mean nothing here, and silently ignoring them would print the
    // whole report as though the question had been answered.
    if (args.rest.length > 0) {
      throw new Error(
        `overview takes no arguments — did you mean --only ${args.rest.join(",")}? (or 'bumpii add ${args.rest.join(" ")}')`,
      );
    }
    const engine = args.noJudge
      ? { kind: "none" as const, model: "", label: "skipped (--no-judge)" }
      : await resolveEngine({ model: args.model });
    const overview = await buildOverview(config, {
      engine,
      only: args.only,
      concurrency: JUDGE_CONCURRENCY,
    });
    // A typo in --only must not read as "nothing is outdated". Checked after
    // the build rather than against the config, because overview ranges over
    // everything brew has pending, not only what is tracked — and only when
    // NOTHING matched: a name that is simply current still has something true
    // to show under "up to date", which is an answer rather than an error.
    if (
      args.only.length > 0 &&
      overview.entries.length === 0 &&
      overview.current.length === 0 &&
      overview.unchecked.length === 0
    ) {
      throw new Error(
        `nothing matched --only ${args.only.join(",")} — no package by that name is installed or tracked; ` +
          `run 'bumpii overview' without --only, or 'bumpii list' for the names you track`,
      );
    }
    process.stdout.write(args.json ? `${JSON.stringify(overview, null, 2)}\n` : renderOverview(overview));
    // Same contract as the digest: non-zero when something is pending, so a
    // scheduled run can act on it without parsing the report.
    return overview.entries.length > 0 ? 1 : 0;
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
