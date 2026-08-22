// SPDX-License-Identifier: GPL-3.0-or-later
// One picture of everything Homebrew has pending, sorted by whether it can say
// anything useful about it.
//
// The digest command answers "what changed in the tools I track". This answers
// the question that comes before it: of everything the machine could upgrade
// right now, which ones are worth reading about at all — including the ones
// never added to tools.json. The filter is your own files: a package no file of
// yours names gets a version and a link and nothing more, because there is no
// usage to judge a release note against, and running a model over it would
// produce an opinion rather than a verdict.
import { digest, type Engine } from "./judge.ts";
import { limiter } from "./limit.ts";
import {
  brewInstalledVersions,
  brewOutdated,
  compareUrl,
  type OutdatedPackage,
  resolveSources,
} from "./outdated.ts";
import type { Progress } from "./progress.ts";
import { listReleases, parseSource } from "./sources.ts";
import type { Config, DigestItem, Release, ToolConfig } from "./types.ts";
import { referenceCounts, resolveUsagePaths } from "./usage.ts";
import { compareVersions, isComparable, isOrderable, isTruncated, releasesBehind } from "./version.ts";

/** Why an entry ended up where it did. Each bucket renders differently. */
export type Bucket =
  /** Referenced, forge read, and the engine produced something. */
  | "digested"
  /**
   * Referenced and the forge was read, but no items came back — the engine was
   * off, failed, or there was nothing between the two versions to digest. Kept
   * apart from `digested` so the heading and the tally cannot claim a reading
   * that did not happen.
   */
  | "undigested"
  /** Referenced, but nothing names a forge repo, so there is nothing to read. */
  | "no-repo"
  /** Referenced, its forge was named, but reaching or reading it failed. */
  | "unreachable"
  /** No file of yours names it — listed with a link, never judged. */
  | "no-signal";

export interface OverviewEntry {
  name: string;
  installed: string;
  latest: string;
  kind: OutdatedPackage["kind"];
  pinned: boolean;
  /** Already in tools.json — shown, because it changes what you would do next. */
  tracked: boolean;
  /** How many of your files name it. Zero is what puts an entry in "no-signal". */
  refs: number;
  source: string | null;
  /** The command that would upgrade it. */
  update: string;
  bucket: Bucket;
  /** Releases between installed and latest, oldest first. */
  behind: Release[];
  /**
   * Comparable releases the forge published at all. Zero says something quite
   * different from an empty `behind`: one means nothing could be compared, the
   * other that nothing changed between these two versions, and rendering both
   * as "no release notes" reads as "nothing changed" for a repo that simply
   * never publishes releases.
   */
  published: number;
  /**
   * The forge's page ran out before `behind` did, so the count is a floor.
   * Rendered as "N+", the same as the digest does — a silent cap makes a tool
   * thirty releases behind look routine.
   */
  truncated: boolean;
  items: DigestItem[];
  /** Diff between the installed and the newest tag, when both tags are known. */
  compare: string | null;
  /** Why this landed in "unreachable", or why its digest came back empty. */
  error?: string;
}

export interface Overview {
  entries: OverviewEntry[];
  /** Tracked, brew-managed, nothing pending — checked, and genuinely current. */
  current: { name: string; installed: string; refs: number }[];
  /**
   * Tracked, but nothing here checked them. Either brew does not manage them at
   * all (container entries, anything installed by hand) or it does and they are
   * not installed — brew is equally silent about both, and folding that silence
   * into "up to date" would be the confident wrong answer this tool exists to
   * avoid. `bumpii` itself is what checks the first kind.
   */
  unchecked: { name: string; refs: number; reason: "not-brew" | "not-installed" }[];
  missingUsagePaths: string[];
  /**
   * The config names no usagePaths at all. Distinct from `missingUsagePaths`
   * (paths named but absent on disk), and it has to be said out loud: with
   * nothing to search, every reference count is zero, everything lands under
   * "no signal", and the report would be asserting absence about paths nobody
   * ever gave it.
   */
  noUsagePaths: boolean;
  /**
   * grep did not get to the end of the walk, so every "affects you" below is a
   * floor rather than the answer. One grep serves the whole run, which is why
   * this sits here and not on each entry.
   */
  usageIncomplete?: string;
  /**
   * Pending packages --only filtered out of this report. The "nothing
   * outdated" headline reads "no newer version for anything installed", and
   * with a filter active that claims more than was answered — brew may well
   * have five packages pending that the question simply excluded.
   */
  filteredOut: number;
  engine: Engine;
}

/**
 * The formula an entry upgrades, so a tracked tool is recognised under the name
 * brew reports rather than the binary it is keyed on (forgejo-cli ships `fj`).
 * Kept here rather than imported from cli.ts to avoid a module that runs a CLI.
 */
function formulaOf(update: string): string | null {
  const m = /brew\s+(?:upgrade|install)\s+(.+)/.exec(update);
  const formula = m?.[1]?.split(/\s+/).find((w) => w && !w.startsWith("-"));
  return formula ?? null;
}

/**
 * Every name a tracked tool answers to, for matching against brew's output and
 * for counting references.
 *
 * Both uses need all of them. brew reports `forgejo-cli`; every script calls
 * `fj`. Counting references under brew's name alone measured the wrong string —
 * 1 file instead of 19 on one real machine — and a zero there does not merely
 * mis-rank the entry, it prints "no file in your usagePaths names these" about
 * a tool named in nineteen of them.
 */
export function namesOf(tool: ToolConfig): string[] {
  const formula = formulaOf(tool.update);
  const short = (s: string) => s.split("/").pop() ?? s;
  return [...new Set([tool.name, ...(formula ? [formula, short(formula)] : [])])];
}

/**
 * The --only list, widened to every alias of each tool it names. Exported for
 * the test that holds the pending half and the quiet half to the same rule.
 */
export function expandOnly(only: string[], tools: ToolConfig[]): Set<string> {
  const out = new Set(only);
  if (out.size === 0) return out;
  for (const t of tools) {
    const names = namesOf(t);
    if (names.some((n) => out.has(n))) for (const n of names) out.add(n);
  }
  return out;
}

/**
 * How many of brew's outdated packages nothing in `tools` covers.
 *
 * Pulled out of `buildOverview` so the digest command can point at "N more
 * packages have updates" without running a second digest over them — this is
 * a count, not a judgement, so it costs nothing beyond the `brew outdated`
 * call already needed to produce it. Pure for the same reason `bucketFor` is:
 * testable without brew standing behind it.
 */
export function untrackedOutdatedCount(outdated: OutdatedPackage[], tools: ToolConfig[]): number {
  const trackedNames = new Set(tools.flatMap((t) => namesOf(t)));
  return outdated.filter((p) => !trackedNames.has(p.name)).length;
}

/**
 * The tag that carried a version, from the releases the forge actually
 * published. Returns null rather than a guess: a compare URL built from an
 * invented tag 404s, which reads as a broken tool rather than as missing data.
 */
/**
 * The tag the forge published for a version, or null if it published none.
 *
 * Two passes, and the exact match keeps its place at the front so nothing that
 * resolves today can start resolving differently. The second pass exists
 * because brew and the forge write the same version differently often enough
 * to matter: brew says `2026.7.4`, yt-dlp tags `2026.07.04`. `compareVersions`
 * has always called those equal — that is why "1 release behind" was right —
 * so a string comparison here meant the report knew the release existed and
 * still dropped the link to it.
 *
 * `isComparable` guards both sides because this list is not filtered: two tags
 * that are not orderable at all (`nightly`, `latest`) parse to the same empty
 * version, and `compareVersions` would call them equal.
 */
export function tagFor(releases: Release[], version: string): string | null {
  const exact = releases.find((r) => r.version === version);
  if (exact) return exact.tag;
  if (!isOrderable(version)) return null;
  return releases.find((r) => isComparable(r) && compareVersions(r.version, version) === 0)?.tag ?? null;
}

/**
 * The compare link for an upgrade, or null when its exact range is not known.
 *
 * Both ends must be tags the forge really published. There used to be a
 * fallback to the newest release we happened to know, and it made the link
 * describe changes the upgrade does not contain: brew offering a revision bump
 * (1.2.3 → 1.2.3_2) produced a link to compare/v1.2.3...v1.2.4 — a working URL,
 * the wrong range, and nothing on screen saying so. No link is the honest
 * answer; the per-release links in the body still work.
 */
export function compareFor(
  source: string,
  releases: Release[],
  installed: string,
  latest: string,
): string | null {
  const from = tagFor(releases, installed);
  const to = tagFor(releases, latest);
  return from && to ? compareUrl(source, from, to) : null;
}

/**
 * The order entries are reported in: bucket first, then most-referenced, then
 * name.
 *
 * Every bucket has to be named here. A bucket the list forgets gets `-1` from
 * `indexOf` and sorts ahead of everything, which is invisible in the text
 * report — render.ts filters per bucket and prints the sections in its own
 * fixed order — and plainly wrong in `--json`, which hands out this array as
 * it stands.
 */
const ORDER: Bucket[] = ["digested", "undigested", "no-repo", "unreachable", "no-signal"];

/**
 * Report order for two entries.
 *
 * Pulled out of `buildOverview` for the same reason as {@link bucketFor}: the
 * ranking is the point of this command, and inside the async flow it can only
 * be checked by standing brew, a forge and an engine up behind it — so nothing
 * ever checked it.
 *
 * Most-referenced first inside each bucket, because alphabetical order would
 * bury the tool you live in under a font.
 */
export function compareEntries(a: OverviewEntry, b: OverviewEntry): number {
  return ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket) || b.refs - a.refs || a.name.localeCompare(b.name);
}

/**
 * Which bucket a package belongs in, from the facts alone.
 *
 * Pulled out of the async flow so the decision can be tested without brew, a
 * forge and an engine standing behind it. That matters more here than the few
 * lines it costs: each bucket puts a different heading above the entry, every
 * one of those headings makes a claim, and this function is the only thing
 * deciding which claim gets made.
 */
export function bucketFor(f: {
  refs: number;
  source: string | null;
  /** Set when reading the forge threw. */
  unreachable?: boolean;
  itemCount: number;
}): Bucket {
  if (f.refs === 0) return "no-signal";
  if (!f.source) return "no-repo";
  if (f.unreachable) return "unreachable";
  // Nothing came back means nothing was digested, whatever the reason — the
  // entry body explains which, and the heading must not overrule it.
  return f.itemCount > 0 ? "digested" : "undigested";
}

export interface OverviewOptions {
  engine: Engine;
  /** Restrict to these names, as `--only` does for the digest. */
  only?: string[];
  /** How many tools may be judged at once. */
  concurrency: number;
  /**
   * Where to report which part of this is running. Optional, and the counts
   * fed to it are the ones this function already keeps — nothing is estimated
   * for the sake of a nicer-looking line.
   */
  progress?: Progress;
}

export async function buildOverview(config: Config, opts: OverviewOptions): Promise<Overview> {
  const progress = opts.progress;
  // On a machine with a few hundred formulae this alone is several seconds of
  // silence before anything else can start.
  progress?.phase("brew");
  const outdated = await brewOutdated();
  // --only names whatever the user calls the tool; brew prints its own name.
  // Expanded through every alias a tracked entry answers to, so `--only fj`
  // matches the `forgejo-cli` brew reports as outdated — the quiet half below
  // already matches this way, and filtering the two halves differently made
  // an aliased, pending tool disappear behind "nothing matched".
  const only = expandOnly(opts.only ?? [], config.tools);
  const wanted = only.size ? outdated.filter((p) => only.has(p.name)) : outdated;

  const usage = await resolveUsagePaths(config.usagePaths);

  // Tracked tools are indexed by every name they answer to, so an entry keyed
  // on a binary still matches the formula brew reports as outdated.
  const trackedBy = new Map<string, ToolConfig>();
  for (const t of config.tools) for (const n of namesOf(t)) trackedBy.set(n, t);

  // Every name anything here answers to, not just the one brew prints. A tool
  // is rarely called by its formula name — brew reports `forgejo-cli`, every
  // script says `fj` — and counting only what brew printed put the second most
  // referenced tool on one real machine at 1 instead of 19, which is the
  // difference between "digest this" and "no file of yours names it".
  const countNames = [
    ...new Set([
      ...wanted.map((p) => p.name),
      ...config.tools.flatMap((t) => namesOf(t)),
      ...config.tools.map((t) => t.name),
    ]),
  ];
  progress?.phase("grep", { commands: countNames.length, roots: usage.roots.length });
  const refs = await referenceCounts(usage.roots, countNames);

  /** The strongest count among the names this package answers to. */
  const refsFor = (pkg: OutdatedPackage): number => {
    const tool = trackedBy.get(pkg.name);
    const names = tool ? [...namesOf(tool), pkg.name] : [pkg.name];
    return Math.max(...names.map((n) => refs.counts.get(n) ?? 0));
  };

  // Resolved for everything pending, not only for what is referenced: the
  // unreferenced list is deliberately unjudged, but it still promises a link,
  // and a link is the one thing that is useful without any judgement at all.
  progress?.phase("discover", { tools: wanted.length });
  const sources = await resolveSources(wanted.map((p) => p.name));

  const limitJudge = limiter(opts.concurrency);

  // Same two counters the digest command keeps, for the same reason: the phase
  // switch below needs the running total, and a count that comes from anywhere
  // other than the work itself is a count that can be wrong.
  let finished = 0;
  let behindTotal = 0;
  let judging = false;
  const done = (): void => progress?.set({ done: ++finished });
  progress?.phase("fetch", { total: wanted.length, done: 0, tools: wanted.length });

  const built: { entry: OverviewEntry }[] = await Promise.all(
    wanted.map(async (pkg): Promise<{ entry: OverviewEntry }> => {
      const tool = trackedBy.get(pkg.name);
      const count = refsFor(pkg);
      // A tracked entry's own source wins: it may have been corrected by hand
      // precisely because brew's URLs point somewhere unhelpful.
      const source = tool?.source || sources[pkg.name] || null;
      const base: OverviewEntry = {
        name: pkg.name,
        installed: pkg.installed,
        latest: pkg.latest,
        kind: pkg.kind,
        pinned: pkg.pinned,
        tracked: Boolean(tool),
        refs: count,
        source,
        update: tool?.update ?? `brew upgrade ${pkg.kind === "cask" ? "--cask " : ""}${pkg.name}`,
        bucket: "no-signal",
        behind: [],
        published: 0,
        truncated: false,
        items: [],
        compare: null,
      };
      if (count === 0) {
        done();
        return { entry: base };
      }
      if (!source) {
        done();
        return {
          entry: { ...base, bucket: bucketFor({ refs: count, source, itemCount: 0 }) },
        };
      }

      try {
        const list = await listReleases(parseSource(source));
        // brew's installed version, not a probe: it has just told us both
        // numbers, and a second answer from the binary could only disagree.
        const behind = releasesBehind(list.releases, pkg.installed);
        const published = list.releases.filter(isComparable).length;
        const truncated = isTruncated(list.releases, behind, list.capped);

        const compare = compareFor(source, list.releases, pkg.installed, pkg.latest);

        behindTotal += behind.length;
        progress?.set({ releases: behindTotal });
        if (!judging && behind.length > 0 && opts.engine.kind !== "none") {
          judging = true;
          progress?.phase("judge", {
            total: wanted.length,
            done: finished,
            tools: wanted.length,
            concurrency: opts.concurrency,
          });
        }

        // A digest that fails costs the summary, not the news — same split the
        // digest command makes, for the same reason.
        let items: DigestItem[] = [];
        let error: string | undefined;
        try {
          items = await limitJudge(() => digest(opts.engine, pkg.name, behind));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        return {
          entry: {
            ...base,
            bucket: bucketFor({ refs: count, source, itemCount: items.length }),
            behind,
            published,
            truncated,
            items,
            compare,
            error,
          },
        };
      } catch (err) {
        return {
          entry: {
            ...base,
            bucket: bucketFor({ refs: count, source, unreachable: true, itemCount: 0 }),
            error: err instanceof Error ? err.message : String(err),
          },
        };
      } finally {
        // Counted on the failing path too: an unreachable forge is one fewer
        // thing this run is waiting for, and a counter that stalls at 9/12
        // says the opposite.
        done();
      }
    }),
  );

  const entries: OverviewEntry[] = built.map((b) => b.entry);

  // Tracked and not in brew's outdated list. Split on whether brew was in a
  // position to say so at all: an entry whose update command is not a brew one
  // was never checked here, and reporting it as current would claim a check
  // that never happened.
  const outdatedNames = new Set(outdated.map((p) => p.name));
  const quiet = config.tools
    .filter((t) => !namesOf(t).some((n) => outdatedNames.has(n)))
    // --only restricts the whole report, not only the pending half. Leaving
    // these unfiltered printed every tracked tool under "up to date" after a
    // question about one package, and put its own count in the summary.
    .filter((t) => only.size === 0 || namesOf(t).some((n) => only.has(n)));
  const brewManaged = quiet.filter((t) => formulaOf(t.update) !== null);
  progress?.phase("brew");
  const installedVersions = await brewInstalledVersions(
    brewManaged.flatMap((t) => {
      const f = formulaOf(t.update);
      return f ? [f] : [];
    }),
  );
  const refsForTool = (t: ToolConfig) => Math.max(...namesOf(t).map((n) => refs.counts.get(n) ?? 0));

  // "Not in the outdated list" has two causes, and only one of them is good
  // news. brew stays just as silent about a formula that is not installed at
  // all, so requiring a version from `brew list` is what separates "checked,
  // current" from "brew had nothing to say" — without it, a tool you never
  // installed renders under "up to date" with a bare "?" as the only hint.
  const current: Overview["current"] = [];
  const unchecked: Overview["unchecked"] = [];
  for (const t of quiet) {
    const formula = formulaOf(t.update);
    const installed = formula ? installedVersions.get(formula) : undefined;
    if (!formula) {
      unchecked.push({ name: t.name, refs: refsForTool(t), reason: "not-brew" });
    } else if (!installed) {
      unchecked.push({ name: t.name, refs: refsForTool(t), reason: "not-installed" });
    } else {
      current.push({ name: t.name, installed, refs: refsForTool(t) });
    }
  }

  entries.sort(compareEntries);
  current.sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name));
  unchecked.sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name));

  return {
    entries,
    current,
    unchecked,
    missingUsagePaths: usage.missing,
    noUsagePaths: config.usagePaths.length === 0,
    usageIncomplete: refs.incomplete,
    filteredOut: outdated.length - wanted.length,
    engine: opts.engine,
  };
}
