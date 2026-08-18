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
import {
  binariesOf,
  brewJsonMany,
  discoverFormula,
  installedFormulae,
  leaves,
  untrackedFormulae,
} from "./discover.ts";
import { killChildren, run } from "./exec.ts";
import { discoverImage, untrackedContainers } from "./images.ts";
import { buildInbox, markThreadsRead, shownThreads } from "./inbox.ts";
import { digest, resolveEngine } from "./judge.ts";
import { limiter } from "./limit.ts";
import { brewOutdated } from "./outdated.ts";
import { buildOverview, untrackedOutdatedCount } from "./overview.ts";
import { type Progress, startProgress } from "./progress.ts";
import { renderInbox, renderOverview, renderReport } from "./render.ts";
import { channelStatus, listReleases, parseSource } from "./sources.ts";
import type { DigestItem, Release, ToolConfig, ToolReport } from "./types.ts";
import { commandsFromNotes, findUsageAcross, mentioned, resolveUsagePaths } from "./usage.ts";
import { installedVersion, isTruncated, latestComparable, releasesBehind } from "./version.ts";

/**
 * How many tools' releases may be judged at once.
 *
 * Low enough that a local single-model server (oMLX, Ollama) is not asked to
 * hold this many requests in flight at once, high enough that a hosted engine
 * still overlaps several tools instead of running the whole digest serially.
 *
 * Raising it does not make a cold run faster, which is worth knowing before
 * trying: measured on claude-cli/haiku over 24 pending packages, 3 → 109.6s,
 * 6 → 107.9s, 12 → 103.6s, with every arm judging the same five tools. The
 * wall-clock is one call, not a queue — uv's notes alone took 115.7s, because
 * it documents 23 distinct changes and the model has to write all of them, so
 * no amount of overlap gets below the slowest single tool. The cache is what
 * addresses this, by making the second run skip the call entirely.
 */
const JUDGE_CONCURRENCY = 3;

const HELP = `bumpii — what changed in the CLIs and containers you run, judged against your usage

  bumpii                  this help — the digest has to be asked for by name
  bumpii digest           digest pending releases for every configured tool
  bumpii overview         everything brew has pending, ranked by your own usage
  bumpii inbox            unread GitHub release notifications, digested
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
  bumpii digest --yes     digest, then run each tool's update command
  bumpii digest --brew-upgrade
                          digest, then run brew update && brew upgrade —
                          everything brew has pending, tracked or not

Any argument at all runs the command it names, so 'bumpii --only gh' and
'bumpii --json' still digest — only the bare name is help.

Options:
  --image             with add: read the arguments as container names
                      with scan: list containers instead of formulae
  --new               with scan: what arrived recently, not what is untracked
  --unref             with scan: leaves nothing in usagePaths mentions
  --since <14d|3w>    with scan --new: how far back to look (default 14d)
  --deps              with scan --new: list dependencies too, not just requests
  --source <s>        with add: set the repo yourself, for one tool at a time
                      (needed when brew's URLs name no forge, as for node)
  --mark-read         with inbox: mark the shown release threads read
  --only <name,...>   restrict to these tools, or with overview these packages
  --model <id>        force a judge model instead of discovering one
  --json              machine-readable report
  --no-judge          skip the model; list pending releases and their URLs
  --dry-run           with add: show the entries, write nothing
                      with --yes/--brew-upgrade: print the update commands
                      that would run, and run none of them
  --brew-upgrade      after the digest, run brew update && brew upgrade —
                      unjudged, and not limited to tools.json
  -h, --help

Config: ${configPath()}
Engine: OPENAI_BASE_URL (oMLX/Ollama/vLLM) is preferred, else the \`claude\` CLI.
`;

interface Args {
  cmd: "digest" | "overview" | "inbox" | "init" | "add" | "scan" | "list" | "set" | "rm" | "help";
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
  /** With `inbox`: mark the shown release threads read afterwards. */
  markRead: boolean;
  /** Run `brew update && brew upgrade` after the digest — everything brew has
   * pending, not only tools.json, and never judged first. */
  brewUpgrade: boolean;
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
    markRead: false,
    brewUpgrade: false,
    only: [],
    rest: [],
  };
  // `bumpii` on its own is help, not a digest.
  //
  // The digest is the most expensive thing here — a forge round-trip per tool
  // and a model that can sit on one release for minutes — and it used to be
  // what you got for typing the bare name, which is the easiest command in the
  // world to run by accident. Nothing else changes: any argument at all, flag
  // or subcommand, means somebody meant it, so `bumpii --only gh` and the
  // `bumpii --json` in a cron line behave exactly as before.
  if (argv.length === 0) return { ...a, cmd: "help" };

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
        v === "overview" ||
        v === "inbox" ||
        v === "digest")
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
    else if (v === "--mark-read") a.markRead = true;
    else if (v === "--brew-upgrade") a.brewUpgrade = true;
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
 * Whether an update line deliberately says "there is no command for this".
 *
 * A different statement from a placeholder: `# complete this: …` is an entry
 * waiting to be finished, and `list` rightly counts it as a gap; `manual: open
 * the app's updater` is the entry being complete — some tools (Ghostty's
 * Sparkle updater) simply have no CLI trigger. `--yes` skips both, but only
 * the placeholder is a failure: nothing about a manual entry is broken.
 */
export function isManualUpdate(update: string): boolean {
  return /^manual(:|$)/i.test(update.trim());
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

/**
 * One progress line for the whole command, stopped on every exit path.
 *
 * Started out here rather than inside each branch so that a command is one
 * animation from start to finish — the ball keeps bouncing across resolving an
 * engine, reading forges and judging, instead of a fresh spinner per step.
 */
async function main(): Promise<number> {
  const progress = startProgress();
  installSignalHandlers(progress);
  try {
    return await dispatch(progress);
  } finally {
    progress.stop();
    // Not only for signals: a tool's probe and its forge fetch run as one
    // Promise.all, so a 404 rejects the pair while the probe is still running.
    // The report prints, process.exit follows, and the probe is left orphaned
    // — reproduced with a `sleep` as version.cmd against a bad source. Nothing
    // here is worth stranding: probes, `claude`, and `brew upgrade` alike.
    killChildren();
  }
}

/**
 * Leave the terminal and the process table as they were found.
 *
 * Two things do not happen on their own when this is interrupted. Node's
 * default SIGINT handling terminates without running `exit` listeners, so the
 * progress line's cursor-restore never fires and Ctrl-C during a judge hands
 * back a terminal with no cursor. And a killed parent does not kill its
 * children: measured, SIGINT left the child running and reparented, which for
 * a judge is a `claude` still working and for `--yes` a `brew upgrade` still
 * compiling.
 *
 * Registering a SIGINT listener at all switches off Node's default exit, so
 * every path out of here must end in process.exit — a handler that returned
 * would leave Ctrl-C doing nothing at all, which is worse than what it fixes.
 * `once`, so a second Ctrl-C restores the default and kills it outright even
 * if this is what is stuck. 128+signal is the conventional code a shell
 * reports for a signalled process, and scripts read it.
 */
function installSignalHandlers(progress: Progress): void {
  const handle = (code: number): void => {
    progress.stop();
    // SIGTERM regardless of what arrived here, because the children are not
    // all interactive programs: a non-interactive `sh -c` defers SIGINT until
    // its current foreground command finishes, so passing the signal through
    // let a probe run to completion and write its output anyway — measured.
    // SIGTERM is the one every one of them treats as "stop now", and it still
    // lets `claude` and `brew` shut down on their own terms.
    killChildren("SIGTERM");
    process.exit(code);
  };
  process.once("SIGINT", () => handle(130));
  process.once("SIGTERM", () => handle(143));
}

async function dispatch(progress: Progress): Promise<number> {
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
    progress.phase("brew");
    const fresh = (await installedFormulae())
      .filter((f) => f.installedAt !== null && f.installedAt >= cutoff)
      .sort((a, b) => (b.installedAt ?? 0) - (a.installedAt ?? 0));
    progress.pause();

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

    progress.phase("brew");
    const leafNames = await leaves();
    const receipts = new Map((await installedFormulae()).map((f) => [f.name, f]));
    progress.phase("discover", { tools: leafNames.length });
    // A formula is often not called by its own name — forgejo-cli ships `fj` —
    // so the binaries it installs are searched for too. Grepping the formula
    // name alone would report it as unmentioned while every script calls it.
    const candidates = await Promise.all(
      leafNames.map(async (formula) => {
        const short = formula.split("/").pop() ?? formula;
        return { formula, needles: [...new Set([formula, short, ...(await binariesOf(short))])] };
      }),
    );
    const needles = [...new Set(candidates.flatMap((c) => c.needles))];
    progress.phase("grep", { commands: needles.length, roots: usage.roots.length });
    const found = await mentioned(usage.roots, needles);
    const unref = candidates.filter((c) => !c.needles.some((n) => found.has(n)));
    progress.pause();

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
    progress.phase("discover");
    const { runtime, running, untracked } = await untrackedContainers(tracked);
    progress.pause();
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
    progress.phase("brew");
    const untracked = await untrackedFormulae(tracked);
    progress.pause();
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

    // What brew knows about all of them, in one call rather than one per name:
    // brew starting is what costs, not the length of the list. The container
    // path has no equivalent — an inspect is per container by nature.
    progress.phase("discover", { tools: args.rest.length, total: args.rest.length, done: 0 });
    const brewKnown = args.image ? undefined : await brewJsonMany(args.rest);

    // Concurrently: each entry costs an inspect or a brew call, and on the
    // brew path up to five version probes able to sit out their own timeout.
    const settled = await Promise.all(
      args.rest.map(async (name) => {
        try {
          // One unresolvable name must not sink the rest of the batch.
          const d = args.image
            ? await discoverImage(name)
            : await discoverFormula(name, args.source, brewKnown);
          return { ok: true as const, value: d };
        } catch (err) {
          return { ok: false as const, message: (err as Error).message };
        } finally {
          progress.step();
        }
      }),
    );
    progress.pause();
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

  if (args.cmd === "inbox") {
    progress.phase("config");
    const config = await loadConfig();
    if (args.rest.length > 0) {
      throw new Error("inbox takes no arguments — it reads your unread GitHub notifications as they are");
    }
    progress.phase("engine");
    const engine = args.noJudge
      ? { kind: "none" as const, model: "", label: "skipped (--no-judge)" }
      : await resolveEngine({ model: args.model });
    progress.set({ engine: engine.kind });
    const inbox = await buildInbox(config, { engine, concurrency: JUDGE_CONCURRENCY, progress });
    progress.pause();
    process.stdout.write(args.json ? `${JSON.stringify(inbox, null, 2)}\n` : renderInbox(inbox));

    if (args.markRead) {
      // Only threads whose releases were actually shown; an entry that errored
      // showed nothing, and its notification is the only reminder it exists.
      const threads = shownThreads(inbox.entries);
      const failures = await markThreadsRead(threads);
      for (const f of failures) process.stderr.write(`mark-read failed: ${f}\n`);
      if (threads.length > 0 && failures.length === 0) {
        process.stdout.write(
          `marked ${threads.length} release notification${threads.length === 1 ? "" : "s"} read\n`,
        );
      }
      // A cron that relies on --mark-read has to be able to say it did not
      // happen — otherwise the same releases arrive again as "new" next run.
      if (failures.length > 0) return 2;
    }
    return inbox.entries.length > 0 ? 1 : 0;
  }

  if (args.cmd === "overview") {
    progress.phase("config");
    const config = await loadConfig();
    // Positionals mean nothing here, and silently ignoring them would print the
    // whole report as though the question had been answered.
    if (args.rest.length > 0) {
      throw new Error(
        `overview takes no arguments — did you mean --only ${args.rest.join(",")}? (or 'bumpii add ${args.rest.join(" ")}')`,
      );
    }
    progress.phase("engine");
    const engine = args.noJudge
      ? { kind: "none" as const, model: "", label: "skipped (--no-judge)" }
      : await resolveEngine({ model: args.model });
    progress.set({ engine: engine.kind });
    const overview = await buildOverview(config, {
      engine,
      only: args.only,
      concurrency: JUDGE_CONCURRENCY,
      progress,
    });
    progress.pause();
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

  // Positionals mean nothing here, and swallowing them printed the whole
  // report as though the question had been answered — the same trap `overview`
  // already guards, now reachable by name as `bumpii digest gh`.
  if (args.rest.length > 0) {
    throw new Error(
      `digest takes no arguments — did you mean --only ${args.rest.join(",")}? (or 'bumpii add ${args.rest.join(" ")}')`,
    );
  }

  progress.phase("config");
  const config = await loadConfig();
  const tools = args.only.length ? config.tools.filter((t) => args.only.includes(t.name)) : config.tools;
  if (tools.length === 0)
    throw new Error(`no tools matched --only ${args.only.join(",")} — see 'bumpii list' for the names`);

  // Probing a model server is one of the two places a run can sit still before
  // it has anything to show for it, so it gets said out loud.
  progress.phase("engine", { tools: tools.length });
  const engine = args.noJudge
    ? { kind: "none" as const, model: "", label: "skipped (--no-judge)" }
    : await resolveEngine({ model: args.model });
  progress.set({ engine: engine.kind });

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
  //
  // Two passes: fetch and judge per tool, then ONE grep for every command they
  // extracted between them. Grepping inside the map re-walked the usagePaths
  // for each tool, which is the same trees read once per tracked tool to
  // answer a single question about all of them.
  // Counted here rather than read back out of the progress line: the phase
  // switch below needs the running total to carry it across, and a spinner
  // that owns numbers nobody else can see is a spinner that can drift from
  // the run it claims to describe.
  let finished = 0;
  let behindTotal = 0;
  let judging = false;
  const done = (): void => progress.set({ done: ++finished });

  progress.phase("fetch", { total: tools.length, done: 0, tools: tools.length });
  const built: { report: ToolReport; commands: string[] }[] = await Promise.all(
    tools.map(async (tool): Promise<{ report: ToolReport; commands: string[] }> => {
      const base: ToolReport = { tool, installed: null, latest: null, behind: [], items: [], hits: [] };
      // No source means there is nothing to ask, so no forge is contacted and
      // no version probed — render.ts reports it as waiting for one line.
      if (!tool.source) {
        done();
        return { report: base, commands: [] };
      }
      try {
        const ref = parseSource(tool.source);
        let installed: string | null;
        let behind: Release[];
        let latest: string | null;
        let truncated: boolean;
        let channel: ToolReport["channel"];
        if (tool.channel) {
          // A rolling channel is compared from the installed build's commit,
          // so the probe has to answer before the forge can be asked anything
          // — sequential where the release path runs both at once.
          installed = await installedVersion(tool);
          const ch = await channelStatus(ref, tool.channel, installed);
          behind = ch.release ? [ch.release] : [];
          latest = ch.head;
          truncated = ch.truncated;
          channel = { tag: tool.channel, aheadBy: ch.aheadBy };
        } else {
          const [inst, list] = await Promise.all([installedVersion(tool), listReleases(ref)]);
          installed = inst;
          behind = releasesBehind(list.releases, inst);
          latest = latestComparable(list.releases);
          truncated = isTruncated(list.releases, behind, list.capped);
        }

        behindTotal += behind.length;
        progress.set({ releases: behindTotal });
        // From the first digest on, judging is what the run is waiting for —
        // fetches still finishing behind it are not what makes it slow. The
        // count carries across because both phases count the same thing: tools
        // fully dealt with, out of the tools asked about.
        if (!judging && behind.length > 0 && engine.kind !== "none") {
          judging = true;
          progress.phase("judge", {
            total: tools.length,
            done: finished,
            tools: tools.length,
            concurrency: JUDGE_CONCURRENCY,
          });
        }

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

        // No items means no extracted commands, so without this the whole
        // "affects you" half of the report disappears for anyone running
        // without an engine — which is the configuration this tool has to keep
        // working in, not a degraded one.
        const mechanical = items.length === 0 && behind.length > 0;
        return {
          report: {
            ...base,
            mechanical,
            installed,
            latest,
            behind,
            truncated,
            channel,
            items,
            digestError,
          },
          commands: mechanical
            ? behind.flatMap((r) => commandsFromNotes(tool.name, r.notes))
            : items.flatMap((i) => i.commands),
        };
      } catch (err) {
        return {
          report: { ...base, error: err instanceof Error ? err.message : String(err) },
          commands: [],
        };
      } finally {
        // Both paths: a tool that failed is still a tool this run is done
        // waiting for, and a counter that only advances on success stalls at
        // 9/12 for the rest of a run that is actually progressing.
        done();
      }
    }),
  );

  const commandCount = built.reduce((n, b) => n + b.commands.length, 0);
  progress.phase("grep", { commands: commandCount, roots: usage.roots.length });
  const usageHits = await findUsageAcross(
    usage.roots,
    built.map((b) => b.commands),
  );
  const reports: ToolReport[] = built.map((b, i) => ({ ...b.report, hits: usageHits[i] ?? [] }));

  // What this digest never looked at: everything brew has pending that
  // tools.json does not track. `undefined` on failure — brew missing (Linux
  // CI, no Homebrew) or erroring costs this line, not the digest above it.
  let otherPending: number | undefined;
  progress.phase("brew");
  try {
    otherPending = untrackedOutdatedCount(await brewOutdated(), config.tools);
  } catch {
    otherPending = undefined;
  }

  // Everything below writes the report, so the line comes down first — an
  // animation and a report sharing a row is how a spinner ends up frozen in
  // somebody's scrollback.
  progress.pause();
  const noUsagePaths = config.usagePaths.length === 0;
  if (args.json) {
    // The whole engine, not just its label: a scheduled run that acts on this
    // should be able to branch on "was anything actually judged" without
    // parsing prose.
    process.stdout.write(
      `${JSON.stringify({ engine, missingUsagePaths: usage.missing, noUsagePaths, otherPending, reports }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      renderReport(reports, { engine, missingPaths: usage.missing, noUsagePaths, otherPending }),
    );
  }

  let updateFailures = 0;
  // What `--yes` would run, without running any of it.
  //
  // The same flag `add` already uses, for the same reason: the commands come
  // out of a config file this tool never wrote, and reading them before they
  // execute is the difference between an update and a surprise. It prints the
  // real update lines — not a description of them — and still reports a
  // placeholder as the failure it would be, because finding that out during
  // an unattended run is the case worth avoiding.
  if ((args.yes || args.brewUpgrade) && args.dryRun) {
    const runnable: string[] = [];
    for (const r of args.yes ? reports : []) {
      if (r.error || !r.installed || r.behind.length === 0) continue;
      if (isManualUpdate(r.tool.update)) {
        process.stdout.write(`${r.tool.name}: ${r.tool.update.trim()} — nothing to run\n`);
        continue;
      }
      if (isPlaceholderUpdate(r.tool.update)) {
        updateFailures++;
        process.stderr.write(
          `${r.tool.name}: update line is still a placeholder (${r.tool.update.trim()}) — would be skipped\n`,
        );
        continue;
      }
      runnable.push(`  $ ${r.tool.update}`);
    }
    if (args.brewUpgrade) runnable.push("  $ brew update && brew upgrade");
    process.stdout.write(
      runnable.length > 0
        ? `\nwould run ${runnable.length} command${runnable.length === 1 ? "" : "s"}:\n${runnable.join("\n")}\n` +
            `\n--dry-run: nothing was run\n`
        : `\nnothing to run\n`,
    );
    // Deliberately not the --yes exit code: nothing was updated, so whatever
    // was pending still is, and a scheduled dry run has to keep saying so.
    // A placeholder still reports 2 — it is broken now, not once it runs.
    if (updateFailures > 0) return 2;
    if (reports.some((r) => !r.error && r.behind.length > 0)) return 1;
    if (reports.some((r) => r.error)) return 2;
    return 0;
  }

  if (args.yes) {
    // Picked back up rather than started fresh: the report is printed but the
    // command is not over, and `brew upgrade` is the longest silence in it.
    const pending = reports.filter((r) => !r.error && r.installed && r.behind.length > 0);
    progress.phase("update", { total: pending.length, done: 0 });
    progress.resume();
    for (const r of reports) {
      if (r.error || !r.installed || r.behind.length === 0) continue;
      // A manual entry is complete — there is simply no command to run — so
      // skipping it is routine, not a failure, and must not turn the exit
      // code red the way an unfinished placeholder does.
      if (isManualUpdate(r.tool.update)) {
        progress.out(`${r.tool.name}: ${r.tool.update.trim()} — skipped\n`);
        progress.step();
        continue;
      }
      // A placeholder update line is a comment, which `sh -c` runs happily and
      // exits 0 on — reporting a successful update that never happened. That
      // is the exact class of quiet wrong answer this tool exists to avoid.
      if (isPlaceholderUpdate(r.tool.update)) {
        updateFailures++;
        progress.err(
          `${r.tool.name}: update line is still a placeholder (${r.tool.update.trim()}) — skipped\n`,
        );
        progress.step();
        continue;
      }
      progress.out(`\n$ ${r.tool.update}\n`);
      try {
        const out = await run("/bin/sh", ["-c", r.tool.update], { timeout: 600_000 });
        progress.out(out.stdout);
      } catch (err) {
        // Keep going: one formula failing to build should not block the others.
        updateFailures++;
        progress.err(`${r.tool.name}: update failed: ${(err as Error).message}\n`);
      }
      progress.step();
    }
    progress.pause();
  }

  // Deliberately not folded into the --yes loop above: that one runs a
  // judged, per-tool command; this runs everything brew has pending,
  // tracked or not, with none of it read first. Two different kinds of
  // "yes", so one flag cannot silently imply the other.
  if (args.brewUpgrade && !args.dryRun) {
    const cmd = "brew update && brew upgrade";
    progress.out(`\n$ ${cmd}\n`);
    // Twenty minutes of allowance and not a byte of output until it returns —
    // the one place in this tool where a spinner is not decoration.
    progress.phase("update");
    progress.resume();
    try {
      const out = await run("/bin/sh", ["-c", cmd], { timeout: 1_200_000 });
      progress.out(out.stdout);
    } catch (err) {
      updateFailures++;
      progress.err(`brew update && brew upgrade failed: ${(err as Error).message}\n`);
    }
    progress.pause();
  }

  // An unattended --yes/--brew-upgrade run has to be able to say it did not
  // work; reporting success while something failed to build is how a broken
  // cron goes unseen.
  //
  // The error check is not optional here, and it is the same one the --dry-run
  // branch above makes: `updateFailures` counts only what the update loop hit,
  // and that loop skips every report carrying an error before it can count
  // anything. Without this line a run that reached no forge at all upgraded
  // nothing, failed at nothing, and exited 0 — measured, on the same config
  // that exits 2 without --yes.
  if (args.yes || args.brewUpgrade) {
    if (updateFailures > 0) return 2;
    if (reports.some((r) => r.error)) return 2;
    return 0;
  }
  // Non-zero when something is pending, so a scheduled run can act on it.
  if (reports.some((r) => !r.error && r.behind.length > 0)) return 1;
  // Nothing is pending — but a `0` here means "checked, and nothing was
  // waiting", and a run where forges could not be reached did not check.
  // Pulling the network out of a real run produced twelve errors and exit 0,
  // which is `bumpii --json || notify` staying quiet precisely when it could
  // not see. The report already says "error" per tool; the exit code has to
  // agree with it.
  if (reports.some((r) => r.error)) return 2;
  return 0;
}

// Only run when invoked as the entrypoint. Without this guard, importing
// anything from here (the tests import parseArgs) would execute the whole CLI
// and exit the test runner mid-suite.
/**
 * Everything written, then exit — in that order.
 *
 * Node's stdout is synchronous on a file but asynchronous on a pipe, and
 * `process.exit` drops whatever is still queued. Every consumer that reads a
 * report through `$(bumpii --json)` is the pipe case, and past the 64 KiB pipe
 * buffer it got a document that stopped mid-string — with an exit code saying
 * the run had succeeded. Measured: `inbox --json` writes 93646 bytes to a file
 * and exactly 65536 through a pipe, and the consumer's parser failed on it.
 * Small reports fit in the buffer, which is why only the long ones ever showed
 * it, and why it looked like anything but a size limit.
 *
 * The queued-write callback fires once everything ahead of it has been
 * flushed. When the reader has already closed the pipe (`bumpii --json | head`)
 * it fires with an error instead of never — measured, no hang — so this cannot
 * deadlock the way out.
 */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableLength === 0 || stream.writableEnded || stream.destroyed) {
      resolve();
      return;
    }
    stream.write("", () => resolve());
  });
}

async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}

if (import.meta.main) {
  main()
    .then((code) => exitAfterFlush(code))
    .catch((err: unknown) => {
      process.stderr.write(`bumpii: ${err instanceof Error ? err.message : String(err)}\n`);
      return exitAfterFlush(2);
    });
}
