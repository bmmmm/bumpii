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
import { sourceFromUrls } from "./sources.ts";

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
 * are never going to run `brew upgrade` for.
 */
export async function brewOutdated(): Promise<OutdatedPackage[]> {
  let stdout: string;
  try {
    ({ stdout } = await run("brew", ["outdated", "--json=v2"], { timeout: 300_000 }));
  } catch (err) {
    throw new Error(`brew outdated failed: ${(err as Error).message}`);
  }
  const d = parseBrewJson<{ formulae?: RawOutdated[]; casks?: RawOutdated[] }>(stdout, "brew outdated");
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
 * of JSON the info form costs — and this runs to decorate a line, not to decide
 * anything. A name brew does not manage is simply absent from the result, which
 * is how a tracked entry that is not a brew package stays distinguishable from
 * one that is.
 */
export async function brewInstalledVersions(names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
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
        const { stdout } = await run("brew", argv, { timeout: 120_000 });
        return stdout;
      } catch (err) {
        return (err as ExecError).stdout ?? "";
      }
    }),
  );
  return installedVersionMap(names, formulae ?? "", casks ?? "");
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
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Values are checked, not just the container. A hand-edited `{"gh": 123}`
    // is truthy, so it would be carried all the way to parseSource and surface
    // as "source.startsWith is not a function" — a message about this file that
    // never mentions it. Dropping the bad entry re-derives it instead.
    const out: SourceCache = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || typeof v === "string") out[k] = v;
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
  await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Raw `brew info --json=v2` shapes, for the two fields a source comes out of. */
interface RawInfoFormula {
  name?: string;
  homepage?: string;
  urls?: { stable?: { url?: string }; head?: { url?: string } };
}
interface RawInfoCask {
  token?: string;
  homepage?: string;
  url?: string;
}

/**
 * Ask brew where these packages come from, in one call for all of them.
 *
 * One `brew info` per name would be a network round trip each; brew takes the
 * whole list and answers once. Names it does not know are simply absent from
 * the answer, which is why the result is keyed by what came back rather than by
 * what was asked.
 */
export async function brewSources(names: string[]): Promise<SourceCache> {
  if (names.length === 0) return {};
  let stdout: string;
  try {
    ({ stdout } = await run("brew", ["info", "--json=v2", ...names], { timeout: 300_000 }));
  } catch {
    // brew exits non-zero for the whole batch as soon as one name is unknown,
    // and it writes nothing at all — so the names it does know are lost with
    // it. A formula from a tap that has since gone away is enough to trigger
    // this, and losing the entire report over one dead name is the opposite of
    // what `add` does ("one unresolvable name must not sink the rest").
    // Retried one at a time, and only on this path, so the cost lands on the
    // rare failure rather than on every run.
    if (names.length === 1) return {};
    const each = await Promise.all(names.map((n) => brewSources([n])));
    return Object.assign({}, ...each) as SourceCache;
  }
  const d = parseBrewJson<{ formulae?: RawInfoFormula[]; casks?: RawInfoCask[] }>(stdout, "brew info");
  const out: SourceCache = {};
  for (const f of d.formulae ?? []) {
    if (!f.name) continue;
    out[f.name] = sourceFromUrls([f.urls?.stable?.url ?? "", f.urls?.head?.url ?? "", f.homepage ?? ""]);
  }
  for (const c of d.casks ?? []) {
    if (!c.token) continue;
    // The download URL comes first, and for a cask that ordering matters: it
    // usually points at a release asset, which carries the repo
    // (…/owner/repo/releases/download/…), while the homepage is as often a
    // product page that names no forge at all.
    out[c.token] = sourceFromUrls([c.url ?? "", c.homepage ?? ""]);
  }
  return out;
}

/**
 * Sources for these packages, asking brew only about the ones not cached.
 *
 * A name brew never answered for is recorded as `null` too. Without that, a
 * formula from a tap that has since gone away would be re-asked on every run,
 * and each run would pay a full `brew info` to be told the same nothing.
 */
export async function resolveSources(names: string[], path = sourceCachePath()): Promise<SourceCache> {
  const cache = await readSourceCache(path);
  const missing = names.filter((n) => !(n in cache));
  if (missing.length === 0) return cache;

  const fresh = await brewSources(missing);
  for (const n of missing) cache[n] = fresh[n] ?? null;
  try {
    await writeSourceCache(cache, path);
  } catch {
    // Failing to persist costs a repeat lookup next run, nothing else — not
    // worth sinking a report over.
  }
  return cache;
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
  if (source.startsWith("https://") || source.startsWith("http://")) {
    return `${source.replace(/\.git$/, "").replace(/\/$/, "")}/compare/${enc(fromTag)}...${enc(toTag)}`;
  }
  return null;
}
