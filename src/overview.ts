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
import { listReleases, parseSource } from "./sources.ts";
import type { Config, DigestItem, Release, ToolConfig, UsageHit } from "./types.ts";
import { commandsFromNotes, findUsageAcross, referenceCounts, resolveUsagePaths } from "./usage.ts";
import { isComparable, isTruncated, releasesBehind } from "./version.ts";

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
  hits: UsageHit[];
  /** `hits` were read out of the notes mechanically, with no engine involved. */
  mechanical: boolean;
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
export function tagFor(releases: Release[], version: string): string | null {
  return releases.find((r) => r.version === version)?.tag ?? null;
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
}

export async function buildOverview(config: Config, opts: OverviewOptions): Promise<Overview> {
  const outdated = await brewOutdated();
  const wanted = opts.only?.length ? outdated.filter((p) => opts.only?.includes(p.name)) : outdated;

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
  const refs = await referenceCounts(usage.roots, countNames);

  /** The strongest count among the names this package answers to. */
  const refsFor = (pkg: OutdatedPackage): number => {
    const tool = trackedBy.get(pkg.name);
    const names = tool ? [...namesOf(tool), pkg.name] : [pkg.name];
    return Math.max(...names.map((n) => refs.get(n) ?? 0));
  };

  // Resolved for everything pending, not only for what is referenced: the
  // unreferenced list is deliberately unjudged, but it still promises a link,
  // and a link is the one thing that is useful without any judgement at all.
  const sources = await resolveSources(wanted.map((p) => p.name));

  const limitJudge = limiter(opts.concurrency);

  // Built in two passes: everything each entry can say on its own first, then
  // ONE grep for the commands all of them extracted. Grepping inside the map
  // walked the usagePaths once per pending package — the same trees, for one
  // question, as many times as brew had news.
  const built: { entry: OverviewEntry; commands: string[] }[] = await Promise.all(
    wanted.map(async (pkg): Promise<{ entry: OverviewEntry; commands: string[] }> => {
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
        hits: [],
        mechanical: false,
        compare: null,
      };
      if (count === 0) return { entry: base, commands: [] };
      if (!source)
        return {
          entry: { ...base, bucket: bucketFor({ refs: count, source, itemCount: 0 }) },
          commands: [],
        };

      try {
        const list = await listReleases(parseSource(source));
        // brew's installed version, not a probe: it has just told us both
        // numbers, and a second answer from the binary could only disagree.
        const behind = releasesBehind(list.releases, pkg.installed);
        const published = list.releases.filter(isComparable).length;
        const truncated = isTruncated(list.releases, behind, list.capped);

        const compare = compareFor(source, list.releases, pkg.installed, pkg.latest);

        // A digest that fails costs the summary, not the news — same split the
        // digest command makes, for the same reason.
        let items: DigestItem[] = [];
        let error: string | undefined;
        try {
          items = await limitJudge(() => digest(opts.engine, pkg.name, behind));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        // With no items there are no extracted commands, so nothing would be
        // grepped and the entry would carry a version and a link and nothing
        // else. Reading the notes mechanically keeps the one thing this tool is
        // for — does this touch me — working without an engine at all.
        const mechanical = items.length === 0 && behind.length > 0;
        const commands = mechanical
          ? behind.flatMap((r) => commandsFromNotes(pkg.name, r.notes))
          : items.flatMap((i) => i.commands);
        return {
          entry: {
            ...base,
            bucket: bucketFor({ refs: count, source, itemCount: items.length }),
            mechanical,
            behind,
            published,
            truncated,
            items,
            compare,
            error,
          },
          commands,
        };
      } catch (err) {
        return {
          entry: {
            ...base,
            bucket: bucketFor({ refs: count, source, unreachable: true, itemCount: 0 }),
            error: err instanceof Error ? err.message : String(err),
          },
          commands: [],
        };
      }
    }),
  );

  const hits = await findUsageAcross(
    usage.roots,
    built.map((b) => b.commands),
  );
  const entries: OverviewEntry[] = built.map((b, i) => ({ ...b.entry, hits: hits[i] ?? [] }));

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
    .filter((t) => !opts.only?.length || namesOf(t).some((n) => opts.only?.includes(n)));
  const brewManaged = quiet.filter((t) => formulaOf(t.update) !== null);
  const installedVersions = await brewInstalledVersions(
    brewManaged.flatMap((t) => {
      const f = formulaOf(t.update);
      return f ? [f] : [];
    }),
  );
  const refsForTool = (t: ToolConfig) => Math.max(...namesOf(t).map((n) => refs.get(n) ?? 0));

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

  // Most-referenced first inside each bucket: the ranking is the point, and
  // alphabetical order would bury the tool you live in under a font.
  const ORDER: Bucket[] = ["digested", "no-repo", "unreachable", "no-signal"];
  entries.sort(
    (a, b) =>
      ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket) || b.refs - a.refs || a.name.localeCompare(b.name),
  );
  current.sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name));
  unchecked.sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name));

  return { entries, current, unchecked, missingUsagePaths: usage.missing, engine: opts.engine };
}
