// SPDX-License-Identifier: GPL-3.0-or-later
// What Homebrew already knows is pending, and which forge each of those came
// from.
//
// The digest path (`bumpii` itself) probes every tracked binary for its version
// and asks a forge for the newest one. `overview` does not need either: brew
// has just done both, for everything installed, and its answer covers the
// formulae you never tracked as well. That is the whole reason this module
// exists — the question "what is outdated" is already answered on the machine,
// and re-deriving it would be slower and narrower.
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath } from "./config.ts";
import { type ExecError, run } from "./exec.ts";
import { type ForgeRef, parseSource, sourceFromUrls } from "./sources.ts";

export interface OutdatedPackage {
  name: string;
  /** Version on the machine now. */
  installed: string;
  /** Version brew would upgrade it to. */
  latest: string;
  kind: "formula" | "cask";
  /** Pinned packages are listed by brew but `brew upgrade` will not touch them. */
  pinned: boolean;
}

/** Shape of one entry in `brew outdated --json=v2`; formulae and casks share it. */
interface RawOutdated {
  name?: string;
  installed_versions?: string[];
  current_version?: string;
  pinned?: boolean;
}

/** Exported so a test can drive the real parser rather than re-implement it. */
export function toPackages(raw: RawOutdated[] | undefined, kind: OutdatedPackage["kind"]): OutdatedPackage[] {
  const out: OutdatedPackage[] = [];
  for (const r of raw ?? []) {
    // The newest installed version, not the first: brew keeps every kept-back
    // version in the array, and comparing against an old one would overstate
    // how far behind the package is.
    const installed = r.installed_versions?.at(-1);
    if (!r.name || !installed || !r.current_version) continue;
    out.push({
      name: r.name,
      installed,
      latest: r.current_version,
      kind,
      pinned: r.pinned === true,
    });
  }
  return out;
}

/**
 * Everything brew reports as having a newer version, formulae and casks alike.
 *
 * Casks are included because they upgrade the same way and plenty of them are
 * ordinary tooling — a font, a small utility. Deliberately not `--greedy`:
 * that adds every cask that updates itself, which would list applications you
 * are never going to run `brew upgrade` for. {@link brewSelfUpdating} collects
 * exactly those, separately, because "not an upgrade candidate" is not the same
 * answer as "not out of date".
 */
export async function brewOutdated(): Promise<OutdatedPackage[]> {
  return parseOutdated(await runOutdated([]), "brew outdated");
}

/**
 * The packages `brew outdated` hides: casks marked `auto_updates true`, which
 * only a greedy listing reveals.
 *
 * Leaving them out of the upgrade list is right — `brew upgrade` is not how
 * they get updated, and mixing them in would fill it with applications nobody
 * runs it for. Leaving them out of the ANSWER is not, and that is what was
 * happening: with gcloud-cli behind, `bumpii overview` said "nothing outdated —
 * brew has no newer version for anything installed", and the count under a
 * digest read "no other brew updates pending". Both were reporting a question
 * that had not been asked as a question that had been answered.
 *
 * `--greedy-auto-updates`, NOT `--greedy`. The wide flag also takes in
 * `version :latest` casks, and for those brew cannot compare versions at all —
 * it downloads the artefact to hash it (`outdated_download_sha?` →
 * `new_download_sha` → `Installer#download` in brew's cask.rb). A report is
 * read-only work and must not pull an app bundle to produce a line, least of
 * all from a cron. The narrow flag covers the case this exists for — measured
 * here: both flags return exactly `["gcloud-cli"]`, the narrow one in 0.75s.
 *
 * `pending` is what the plain listing returned, and it must be a real answer:
 * pass the caller's empty array only when the plain listing genuinely returned
 * nothing, never when it failed. Subtracting against a stand-in empty list
 * makes every ordinary pending formula come back out of here labelled a
 * self-updating cask.
 */
export async function brewSelfUpdating(pending: OutdatedPackage[]): Promise<OutdatedPackage[]> {
  const greedy = parseOutdated(
    await runOutdated(["--greedy-auto-updates"]),
    "brew outdated --greedy-auto-updates",
  );
  return greedyOnly(greedy, pending);
}

/**
 * What the greedy listing adds to the plain one. Exported so a test can drive
 * the real subtraction rather than re-implement it — and it is a subtraction,
 * not a filter on `kind`: which casks brew hides is brew's business, and
 * hardcoding today's rule here would make this quietly wrong the day it
 * changes.
 *
 * Entries whose installed version equals the latest are dropped. brew answers
 * `installed_versions: ["latest"], current_version: "latest"` for a
 * `version :latest` cask, which would otherwise render as `foo latest → latest`
 * under a heading claiming it is behind — and would narrow the all-clear
 * headline permanently, for a package brew cannot compare at all.
 */
export function greedyOnly(greedy: OutdatedPackage[], pending: OutdatedPackage[]): OutdatedPackage[] {
  const already = new Set(pending.map((p) => p.name));
  return greedy.filter((p) => !already.has(p.name) && p.installed !== p.latest);
}

async function runOutdated(extra: string[]): Promise<string> {
  try {
    const { stdout } = await run("brew", ["outdated", "--json=v2", ...extra], { timeout: 300_000 });
    return stdout;
  } catch (err) {
    throw new Error(
      `brew outdated${extra.length ? ` ${extra.join(" ")}` : ""} failed: ${(err as Error).message}`,
    );
  }
}

function parseOutdated(stdout: string, what: string): OutdatedPackage[] {
  const d = parseBrewJson<{ formulae?: RawOutdated[]; casks?: RawOutdated[] }>(stdout, what);
  return [...toPackages(d.formulae, "formula"), ...toPackages(d.casks, "cask")];
}

/**
 * Parse brew's JSON, naming brew when it is not JSON at all.
 *
 * `Unexpected token 'W', "Warning: s"...` names neither the command that
 * produced it nor anything to do about it — and brew putting a warning or a
 * migration notice on stdout is the ordinary way this happens.
 */
function parseBrewJson<T>(stdout: string, what: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const first = stdout.trim().split("\n")[0] ?? "(no output)";
    throw new Error(
      `${what} did not return JSON — run it yourself to see what it printed instead ` +
        `(first line: ${first.slice(0, 120)})`,
    );
  }
}

/**
 * Installed versions for names brew manages, formulae and casks together.
 *
 * `brew list --versions` rather than `brew info --json=v2 --installed`: the
 * same numbers, but one cheap call instead of the several seconds and megabytes
 * of JSON the info form costs. Observed versions are kept separately from
 * listing errors: missing names establish absence only after both calls finish
 * successfully. The deadline can be shortened to exercise real interruptions
 * without waiting for the production limit.
 */
export async function brewInstalledVersions(
  names: string[],
  timeout = 120_000,
): Promise<{ versions: Map<string, string>; errors: string[] }> {
  if (names.length === 0) return { versions: new Map(), errors: [] };
  // Casks and formulae need separate calls, and each exits non-zero as soon as
  // one name is not of its kind — which is the normal case here, since the list
  // holds both. The output printed before that exit is the part we want, so a
  // failure is parsed rather than discarded: dropping it left every version in
  // the report as "?" while brew had in fact printed them all.
  const [formulae, casks] = await Promise.all(
    [
      ["list", "--versions", ...names],
      ["list", "--cask", "--versions", ...names],
    ].map(async (argv) => {
      try {
        const { stdout } = await run("brew", argv, { timeout });
        return { stdout, error: undefined };
      } catch (err) {
        const failure = err as ExecError;
        return { stdout: failure.stdout ?? "", error: `brew ${argv.join(" ")} failed: ${failure.message}` };
      }
    }),
  );
  // Positive observations survive a failed or timed-out read. Missing names
  // establish absence only when both listings reached a successful end.
  return {
    versions: installedVersionMap(names, formulae?.stdout ?? "", casks?.stdout ?? ""),
    errors: [formulae?.error, casks?.error].filter((e): e is string => e !== undefined),
  };
}

/**
 * Parse brew's `list --versions` output and key the result by the names that
 * were ASKED, not only the names brew prints. Exported so a test can drive the
 * real parser rather than re-implement it.
 *
 * The distinction matters for tap-qualified formulae: the caller asks for
 * `jundot/omlx/omlx` (the name its `brew upgrade` line carries) but brew
 * prints `omlx 0.5.7` — and a map keyed only on the printed name answered
 * `undefined` for a formula that is installed, which the overview then
 * reported as "brew manages these but does not have them".
 */
export function installedVersionMap(
  names: string[],
  formulaeOut: string,
  casksOut: string,
): Map<string, string> {
  const parse = (text: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const line of text.split("\n")) {
      // "name 1.2.3" — and a formula kept at several versions lists them all,
      // newest last, which is the one that is linked.
      const parts = line.trim().split(/\s+/);
      const name = parts[0];
      const version = parts.at(-1);
      if (name && version && parts.length > 1) out.set(name, version);
    }
    return out;
  };
  // Into two maps and merged deterministically, rather than both writing into
  // one: a name that exists as BOTH a formula and a cask (wireshark) would
  // otherwise take whichever call happened to finish last, and the version
  // under "up to date" would change between runs. The formula wins because the
  // caller asks with a name it took from `brew upgrade <formula>`.
  const map = new Map([...parse(casksOut), ...parse(formulaeOut)]);
  for (const n of names) {
    if (map.has(n)) continue;
    const version = map.get(n.split("/").pop() ?? n);
    if (version !== undefined) map.set(n, version);
  }
  return map;
}

/**
 * Where a resolved source lives. Beside tools.json rather than inside it: this
 * is derived data that can be deleted without losing anything a person typed,
 * and mixing it into the file the README invites you to hand-edit would make
 * the two indistinguishable.
 */
export function sourceCachePath(): string {
  return join(dirname(configPath()), "sources.json");
}

/**
 * Cached formula → source lookups. `null` is a real, cached answer: brew names
 * no forge for glib or node, and re-asking on every run would cost a `brew
 * info` for each of them forever to arrive at the same nothing.
 */
export type SourceCache = Record<string, string | null>;

export async function readSourceCache(path = sourceCachePath()): Promise<SourceCache> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const confirmed = parsed.version === 1;
    const values = confirmed ? parsed.sources : parsed;
    if (!values || typeof values !== "object" || Array.isArray(values)) return {};
    const out: SourceCache = {};
    for (const [k, v] of Object.entries(values)) {
      // Legacy nulls cannot distinguish missing metadata from a successful
      // lookup with no forge URL. Revalidate once; only version 1 proves null.
      if (typeof v === "string" || (confirmed && v === null)) out[k] = v;
    }
    return out;
  } catch {
    // A cache is the one file that must never break a run: an unreadable or
    // corrupt one is simply an empty one, and the next write repairs it.
    return {};
  }
}

async function writeSourceCache(cache: SourceCache, path: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, sources: cache }, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Raw `brew info --json=v2` shapes, for the two fields a source comes out of. */
export interface RawInfoFormula {
  name?: string;
  /**
   * The tap-qualified name, present only for tapped formulae. Asked for as
   * `jundot/omlx/omlx`, answered with `omlx` in `name` — so a map keyed on
   * `name` alone cannot be looked up under the name the caller used.
   */
  full_name?: string;
  homepage?: string;
  urls?: { stable?: { url?: string }; head?: { url?: string } };
}
export interface RawInfoCask {
  token?: string;
  homepage?: string;
  url?: string;
}

/**
 * Where a formula's releases live, read off its brew URLs. Shared with
 * notes.ts, which reads the same JSON from `brew info --installed`: one rule
 * for both, or `scan --unmapped` and the overview disagree about a package.
 */
export function formulaSource(f: RawInfoFormula): string | null {
  return sourceFromUrls([f.urls?.stable?.url ?? "", f.urls?.head?.url ?? "", f.homepage ?? ""]);
}

/**
 * The same for a cask. The download URL comes first, and for a cask that
 * ordering matters: it usually points at a release asset, which carries the
 * repo (…/owner/repo/releases/download/…), while the homepage is as often a
 * product page that names no forge at all.
 */
export function caskSource(c: RawInfoCask): string | null {
  return sourceFromUrls([c.url ?? "", c.homepage ?? ""]);
}

export interface SourceLookup {
  sources: SourceCache;
  /** Missing metadata is retryable, never a confirmed absence of a forge. */
  errors: Record<string, string>;
}

/**
 * Ask brew where these packages come from, in one call for all of them.
 *
 * One `brew info` per name would be a network round trip each; brew takes the
 * whole list and answers once. Names it does not know are simply absent from
 * the answer, which is why the result is keyed by what came back rather than by
 * what was asked.
 */
export async function brewSources(names: string[]): Promise<SourceLookup> {
  if (names.length === 0) return { sources: {}, errors: {} };
  try {
    const { stdout } = await run("brew", ["info", "--json=v2", ...names], { timeout: 300_000 });
    const d = parseBrewJson<{ formulae?: RawInfoFormula[]; casks?: RawInfoCask[] }>(stdout, "brew info");
    const sources: SourceCache = {};
    for (const f of d.formulae ?? []) {
      if (!f.name) continue;
      const source = formulaSource(f);
      // Brew answers tapped names under both a short name and full_name.
      for (const key of [f.name, f.full_name]) if (key) sources[key] = source;
    }
    for (const c of d.casks ?? []) {
      if (c.token) sources[c.token] = caskSource(c);
    }
    return {
      sources,
      errors: Object.fromEntries(
        names.filter((n) => !(n in sources)).map((n) => [n, `brew info returned no metadata for ${n}`]),
      ),
    };
  } catch (err) {
    // One unavailable name makes brew fail the batch. Recover successful
    // siblings, but keep failures outside the cache so the next run retries.
    if (names.length === 1)
      return { sources: {}, errors: Object.fromEntries(names.map((n) => [n, String(err)])) };
    const each = await Promise.all(names.map((n) => brewSources([n])));
    return {
      sources: Object.assign({}, ...each.map((r) => r.sources)),
      errors: Object.assign({}, ...each.map((r) => r.errors)),
    };
  }
}

/**
 * Sources for these packages, asking brew only about the ones not cached.
 *
 * Only successful metadata is cached, including a confirmed absence of a
 * forge URL. Failed or absent metadata remains unknown and is retried next run.
 */
export async function resolveSources(names: string[], path = sourceCachePath()): Promise<SourceLookup> {
  const cache = await readSourceCache(path);
  const missing = names.filter((n) => !(n in cache));
  if (missing.length === 0) return { sources: cache, errors: {} };
  const fresh = await brewSources(missing);
  for (const n of missing) if (n in fresh.sources) cache[n] = fresh.sources[n] ?? null;
  try {
    await writeSourceCache(cache, path);
  } catch {
    // Persistence is optional; the measured answer is still valid this run.
  }
  return { sources: cache, errors: fresh.errors };
}

/**
 * A link to the diff between two releases, from the tags the forge really
 * published.
 *
 * Built from tags rather than versions because the prefix is not guessable —
 * jq tags `jq-1.8.2`, gh tags `v2.97.0`, some tag bare numbers — and a compare
 * URL with an invented tag in it is a 404 that looks like a broken tool. Both
 * forge shapes bumpii speaks serve `/compare/a...b` at the same path.
 */
export function compareUrl(source: string, fromTag: string, toTag: string): string | null {
  if (!fromTag || !toTag) return null;
  const enc = (t: string) => encodeURIComponent(t);
  if (source.startsWith("github:"))
    return `https://github.com/${source.slice(7)}/compare/${enc(fromTag)}...${enc(toTag)}`;
  if (source.startsWith("codeberg:")) {
    return `https://codeberg.org/${source.slice(9)}/compare/${enc(fromTag)}...${enc(toTag)}`;
  }
  // GitLab serves the same page under its `/-/` separator; the plain-URL
  // branch below would build a path GitLab reads as a project name.
  let ref: ForgeRef | null = null;
  try {
    ref = parseSource(source);
  } catch {
    return null;
  }
  if (ref.kind === "gitlab") {
    return `${ref.api.replace(/\/api\/v4$/, "")}/${ref.repo}/-/compare/${enc(fromTag)}...${enc(toTag)}`;
  }
  if (source.startsWith("https://") || source.startsWith("http://")) {
    return `${source.replace(/\.git$/, "").replace(/\/$/, "")}/compare/${enc(fromTag)}...${enc(toTag)}`;
  }
  return null;
}
