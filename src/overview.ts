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
import { findUsage, referenceCounts, resolveUsagePaths } from "./usage.ts";
import { releasesBehind } from "./version.ts";

/** Why an entry ended up where it did. Each bucket renders differently. */
export type Bucket =
  /** Referenced by your files and its forge could be reached — notes digested. */
  | "digested"
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
  items: DigestItem[];
  hits: UsageHit[];
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
   * Tracked but outside brew's reach — container entries, anything installed by
   * hand. Named rather than dropped: brew said nothing about these, and folding
   * them into "up to date" would be the confident wrong answer this tool exists
   * to avoid. `bumpii` itself is what checks them.
   */
  unchecked: { name: string; refs: number }[];
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

/** Every name a tracked tool answers to, for matching against brew's output. */
function namesOf(tool: ToolConfig): string[] {
  const formula = formulaOf(tool.update);
  const short = (s: string) => s.split("/").pop() ?? s;
  return [...new Set([tool.name, ...(formula ? [formula, short(formula)] : [])])];
}

/**
 * The tag that carried a version, from the releases the forge actually
 * published. Returns null rather than a guess: a compare URL built from an
 * invented tag 404s, which reads as a broken tool rather than as missing data.
 */
function tagFor(releases: Release[], version: string): string | null {
  return releases.find((r) => r.version === version)?.tag ?? null;
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

  // Counted for the tracked tools too, not only the outdated ones: the
  // "up to date" line carries the same number, and leaving it off there would
  // make the ranking look like it only exists for things that are behind.
  const countNames = [...new Set([...wanted.map((p) => p.name), ...config.tools.map((t) => t.name)])];
  const refs = await referenceCounts(usage.roots, countNames);

  // Only packages your files name can produce a verdict, so only those are
  // worth a `brew info` to find their repo.
  const referenced = wanted.filter((p) => (refs.get(p.name) ?? 0) > 0);
  const sources = await resolveSources(referenced.map((p) => p.name));

  const limitJudge = limiter(opts.concurrency);

  const entries: OverviewEntry[] = await Promise.all(
    wanted.map(async (pkg): Promise<OverviewEntry> => {
      const tool = trackedBy.get(pkg.name);
      const count = refs.get(pkg.name) ?? 0;
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
        items: [],
        hits: [],
        compare: null,
      };
      if (count === 0) return base;
      if (!source) return { ...base, bucket: "no-repo" };

      try {
        const list = await listReleases(parseSource(source));
        // brew's installed version, not a probe: it has just told us both
        // numbers, and a second answer from the binary could only disagree.
        const behind = releasesBehind(list.releases, pkg.installed);
        const fromTag = tagFor(list.releases, pkg.installed);
        const toTag = tagFor(list.releases, pkg.latest) ?? behind.at(-1)?.tag ?? null;
        const compare = fromTag && toTag ? compareUrl(source, fromTag, toTag) : null;

        // A digest that fails costs the summary, not the news — same split the
        // digest command makes, for the same reason.
        let items: DigestItem[] = [];
        let error: string | undefined;
        try {
          items = await limitJudge(() => digest(opts.engine, pkg.name, behind));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const hits = await findUsage(
          usage.roots,
          items.flatMap((i) => i.commands),
        );
        return { ...base, bucket: "digested", behind, items, hits, compare, error };
      } catch (err) {
        return { ...base, bucket: "unreachable", error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  // Tracked and not in brew's outdated list. Split on whether brew was in a
  // position to say so at all: an entry whose update command is not a brew one
  // was never checked here, and reporting it as current would claim a check
  // that never happened.
  const outdatedNames = new Set(outdated.map((p) => p.name));
  const quiet = config.tools.filter((t) => !namesOf(t).some((n) => outdatedNames.has(n)));
  const brewManaged = quiet.filter((t) => formulaOf(t.update) !== null);
  const installedVersions = await brewInstalledVersions(
    brewManaged.flatMap((t) => {
      const f = formulaOf(t.update);
      return f ? [f] : [];
    }),
  );
  const current = brewManaged.map((t) => {
    const formula = formulaOf(t.update);
    return {
      name: t.name,
      installed: (formula ? installedVersions.get(formula) : undefined) ?? "",
      refs: refs.get(t.name) ?? 0,
    };
  });
  const unchecked = quiet
    .filter((t) => formulaOf(t.update) === null)
    .map((t) => ({ name: t.name, refs: refs.get(t.name) ?? 0 }));

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
