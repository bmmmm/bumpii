// SPDX-License-Identifier: GPL-3.0-or-later
// Where a package's release notes live, and reading them on demand.
//
// Three places can say it, in this order: a tracked entry's source, a hand-set
// mapping in tools.json's `packages`, and whatever brew's own URLs name. The
// first two exist because the third is often silent (a project that only
// keeps a NEWS file or a web page) — and `scan --unmapped` exists so that silence is listed rather than
// discovered the day someone asks.
import { run } from "./exec.ts";
import { caskSource, formulaSource, type RawInfoCask, type RawInfoFormula } from "./outdated.ts";
import { namesOf } from "./overview.ts";
import { describeFetchError, FETCH_TIMEOUT_MS, listReleases, parseSource } from "./sources.ts";
import type { Config, PackageMapping, Release } from "./types.ts";

/** One package brew has installed: asked for by name, or a cask. */
export interface InstalledPackage {
  name: string;
  kind: "formula" | "cask";
  /** Brew's newest version, what `{version}` in a page is filled with. */
  version: string | null;
  /** What brew's URLs name, before any hand-set mapping. */
  derived: string | null;
}

type InfoFormula = RawInfoFormula & {
  versions?: { stable?: string };
  installed?: { installed_on_request?: boolean }[];
};
type InfoCask = RawInfoCask & { version?: string };

/**
 * Every formula installed on request, and every cask, in one `brew info`.
 *
 * Dependencies are left out on purpose: nobody reads the release notes of a
 * library they never asked for, and listing them as unmapped would bury the
 * twenty that matter under two hundred that do not.
 */
export async function installedPackages(): Promise<InstalledPackage[]> {
  let raw: string;
  try {
    ({ stdout: raw } = await run("brew", ["info", "--json=v2", "--installed"], { timeout: 300_000 }));
  } catch (err) {
    throw new Error(`brew info --installed failed: ${(err as Error).message}`);
  }
  let d: { formulae?: InfoFormula[]; casks?: InfoCask[] };
  try {
    d = JSON.parse(raw);
  } catch {
    throw new Error(
      `brew info --installed did not return JSON (first line: ${raw.split("\n")[0]?.slice(0, 120)})`,
    );
  }
  const out: InstalledPackage[] = [];
  for (const f of d.formulae ?? []) {
    if (!f.name || f.installed?.at(-1)?.installed_on_request !== true) continue;
    out.push({
      name: f.name,
      kind: "formula",
      version: f.versions?.stable || null,
      derived: formulaSource(f),
    });
  }
  for (const c of d.casks ?? []) {
    if (!c.token) continue;
    // "4.4.1,abc123" — a cask's version carries a build suffix after the comma
    // that no release page is named after.
    const version = c.version && c.version !== "latest" ? (c.version.split(",")[0] ?? null) : null;
    out.push({ name: c.token, kind: "cask", version, derived: caskSource(c) });
  }
  return out;
}

/** Everything known about where one name's notes are. */
export interface NotesTarget {
  name: string;
  source: string | null;
  /** The page with `{version}` filled in, or as written when no version is known. */
  page: string | null;
  /** The page needed a version and none was known, so `page` is the template. */
  pageUnfilled: boolean;
  none: string | null;
  /**
   * The name brew knows it by, when that differs from the one asked for: a
   * tool called `lang` whose update line upgrades `lang@8.1`. Mapping, version
   * and branch all belong to this name, not to the alias.
   */
  key: string;
}

/**
 * Where `name`'s notes are, from the three places that can say so.
 *
 * `installed` is null when brew could not be asked; a name that only brew
 * would know then fails with that reason instead of "no such package".
 */
export function resolveTarget(
  name: string,
  config: Config,
  installed: InstalledPackage[] | null,
  brewError?: string,
): NotesTarget {
  const tool =
    config.tools.find((t) => t.name === name) ?? config.tools.find((t) => namesOf(t).includes(name));
  const pkg =
    installed?.find((p) => p.name === name) ??
    (tool ? installed?.find((p) => namesOf(tool).includes(p.name)) : undefined);
  const mapping = mappingOf(config, name) ?? mappingOf(config, pkg?.name) ?? mappingOf(config, tool?.name);
  if (!tool && !mapping && !pkg) {
    if (!installed) {
      throw new Error(
        `"${name}" is not tracked or mapped, and brew could not be asked about it — ${brewError}`,
      );
    }
    const known = [
      ...new Set([
        ...config.tools.map((t) => t.name),
        ...Object.keys(config.packages ?? {}),
        ...installed.map((p) => p.name),
      ]),
    ];
    const q = name.toLowerCase();
    const near = known.filter((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase())).sort();
    throw new Error(
      `no tool, mapped package or installed package named "${name}"` +
        (near.length ? ` — did you mean ${near.map((n) => `"${n}"`).join(", ")}?` : " — see 'bumpii list'"),
    );
  }
  const template = mapping?.page ?? null;
  const needsVersion = template?.includes("{version}") ?? false;
  const version = pkg?.version ?? null;
  return {
    name,
    source: tool?.source || mapping?.source || pkg?.derived || null,
    page: template && needsVersion && version ? template.replaceAll("{version}", version) : template,
    pageUnfilled: needsVersion && !version,
    none: mapping?.none ?? null,
    key: pkg?.name ?? name,
  };
}

/** An own key only — `packages.constructor` is not a mapping. */
function mappingOf(config: Config, key: string | undefined): PackageMapping | undefined {
  return key !== undefined && config.packages && Object.hasOwn(config.packages, key)
    ? config.packages[key]
    : undefined;
}

/**
 * The name a mapping for `name` is stored under: the brew package a tracked
 * tool upgrades, when it is installed — scan and the overview look packages up
 * by brew's name, and a mapping written under the alias was read by neither.
 */
export function mappingKey(name: string, config: Config, installed: InstalledPackage[] | null): string {
  const tool = config.tools.find((t) => t.name === name);
  if (!tool || !installed) return name;
  return (
    installed.find((p) => p.name === name)?.name ??
    installed.find((p) => namesOf(tool).includes(p.name))?.name ??
    name
  );
}

/**
 * The channel after a non-numeric `@` (`app@preview`, `app@nightly`). Brew
 * installs a prerelease build under it, and the forge path reads stable
 * releases only — so the notes shown are older than what is installed, and
 * the report has to say so.
 */
export function prereleaseChannel(key: string): string | null {
  return /@([^@\d][^@]*)$/.exec(key)?.[1] ?? null;
}

/**
 * The newest `n` releases, in the forge's own order.
 *
 * Not re-sorted by version: GitLab projects may tag `APP_1_4`, which no
 * version comparison can order, and the forge already lists newest first.
 * A versioned formula (`lang@8.1`) keeps only its own branch — a project
 * that publishes every branch in one list would otherwise show the newest
 * 8.5 notes under lang@8.1, the wrong answer stated confidently.
 */
export function pickReleases(
  name: string,
  releases: Release[],
  n: number,
): { picked: Release[]; branch: string | null } {
  const branch = /@(\d+(?:\.\d+)*)$/.exec(name)?.[1] ?? null;
  const pool = branch
    ? releases.filter((r) => r.version === branch || r.version.startsWith(`${branch}.`))
    : releases;
  return { picked: pool.slice(0, n), branch };
}

/** What a page fetch may return at most; longer is cut and said so. */
export const PAGE_CAP = 2 * 1024 * 1024;

/**
 * A release-notes page as text. Plain text (a NEWS file) passes through; HTML
 * is reduced by `pageText`. No token is sent anywhere — a page is not a forge.
 */
export async function fetchPage(url: string): Promise<{ text: string; truncated: boolean }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "text/html, text/plain;q=0.9, */*;q=0.1" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`cannot reach ${new URL(url).host} — ${describeFetchError(err)}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  let body = await res.text();
  const truncated = body.length > PAGE_CAP;
  if (truncated) body = body.slice(0, PAGE_CAP);
  const type = res.headers.get("content-type") ?? "";
  const html = /html/i.test(type) || (!/text\/plain/i.test(type) && /<html|<body|<p\b/i.test(body));
  return { text: (html ? pageText(body) : body).trim(), truncated };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  laquo: "«",
  raquo: "»",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/**
 * HTML reduced to the text a person would read, without a parser.
 *
 * Page chrome goes first, with its content — navigation, scripts and footers
 * are most of the bytes on a release page and none of the news. When the page
 * marks its content (`<main>`, `<article>`), only that is kept; the first
 * article on a news page is the newest post. Block ends become line breaks,
 * so the result keeps the page's paragraphs and lists.
 *
 * Control bytes are not this function's job: the renderer strips them from
 * everything of remote origin, entities decoded here included.
 */
export function pageText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(head|script|style|noscript|svg|nav|header|footer|template|iframe)(?![\w-])[\s\S]*?<\/\1\s*>/gi,
      "",
    );
  // `(?![\w-])`, not `\b`: a hyphen is a word boundary, so `<nav-tabs>` used
  // to open a <nav> that only the footer's </nav> closed — taking the notes
  // between them along, while the run still said "text extracted".
  const main = /<(main|article)(?![\w-])[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(s);
  if (main?.[2]?.replace(/<[^>]+>/g, "").trim()) s = main[2];
  s = s
    .replace(/<h[1-6](?![\w-])[^>]*>/gi, "\n\n")
    .replace(/<li(?![\w-])[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)(?![\w-])[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|dl|dt|dd|pre|blockquote|section|table|article|main)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return (
    decodeEntities(s)
      .split("\n")
      .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
      .join("\n")
      // A list item whose text sits in its own <p> leaves the bullet alone on a
      // line; join it back to what it marks.
      .replace(/^-\n+(?=\S)/gm, "- ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** What `bumpii notes` found, for the renderer and for --json. */
export interface NotesResult extends NotesTarget {
  releases: Release[];
  /** The forge could not be read; its own state, never folded into "no releases". */
  releasesError: string | null;
  /** A versioned formula whose branch had no release among those fetched. */
  branch: string | null;
  /** Installed from a prerelease channel; the releases shown are stable ones. */
  channel: string | null;
  pageText: string | null;
  pageTruncated: boolean;
  pageError: string | null;
}

/**
 * Read the notes for a target: the forge's newest releases, and the page when
 * the forge had nothing to read — no source, an error, or bodies that are all
 * empty (some projects publish GitLab releases with no text at all).
 */
export async function readNotes(target: NotesTarget, last: number): Promise<NotesResult> {
  const result: NotesResult = {
    ...target,
    releases: [],
    releasesError: null,
    branch: null,
    channel: prereleaseChannel(target.key),
    pageText: null,
    pageTruncated: false,
    pageError: null,
  };
  if (target.source) {
    try {
      const list = await listReleases(parseSource(target.source));
      const { picked, branch } = pickReleases(target.key, list.releases, last);
      result.releases = picked;
      result.branch = branch;
    } catch (err) {
      result.releasesError = (err as Error).message;
    }
  }
  const readable = result.releases.some((r) => r.notes);
  if (target.page && !target.pageUnfilled && !readable) {
    try {
      const page = await fetchPage(target.page);
      result.pageTruncated = page.truncated;
      if (page.text) result.pageText = page.text;
      else result.pageError = "the page had no readable text";
    } catch (err) {
      result.pageError = (err as Error).message;
    }
  }
  return result;
}

/** Whether anything readable came back — the line between exit 0 and exit 2. */
export function hasNotes(r: NotesResult): boolean {
  return r.releases.some((x) => x.notes) || Boolean(r.pageText);
}

/** How one installed or tracked name stands, for `scan --unmapped`. */
export type Coverage = "mapped" | "no-notes" | "unchecked" | "none" | "unmapped";

export interface CoverageRow {
  name: string;
  state: Coverage;
  /** The source, page, reason or error that put it in that state. */
  detail: string;
}

/**
 * Every installed package and tracked tool, sorted into what can be said about
 * its notes. A page counts as mapped without fetching it; a source only once
 * the forge has shown a release with text, because a repo that tags without
 * publishing releases is a source with nothing behind it.
 */
export async function coverage(config: Config, installed: InstalledPackage[]): Promise<CoverageRow[]> {
  const names: string[] = [];
  for (const p of installed) names.push(p.name);
  // A tracked tool usually is one of the packages above, under its formula
  // name; only one that is not (an npm CLI, a container) is a row of its own.
  for (const t of config.tools)
    if (!namesOf(t).some((n) => installed.some((p) => p.name === n))) names.push(t.name);
  const rows = await Promise.all(
    [...new Set(names)].map(async (name): Promise<CoverageRow> => {
      const t = resolveTarget(name, config, installed);
      if (t.page) return { name, state: "mapped", detail: t.page };
      if (!t.source)
        return t.none ? { name, state: "none", detail: t.none } : { name, state: "unmapped", detail: "" };
      try {
        // The same page `notes` reads, so the two never disagree about a
        // package: five was too few for a repo whose newest releases are all
        // prereleases, and read as "publishes no releases".
        const list = await listReleases(parseSource(t.source));
        const { picked } = pickReleases(name, list.releases, list.releases.length);
        if (picked.some((r) => r.notes)) return { name, state: "mapped", detail: t.source };
        if (t.none) return { name, state: "none", detail: t.none };
        return {
          name,
          state: "no-notes",
          detail: `${t.source} — ${picked.length ? "its releases carry no text" : "no stable release among the newest it lists"}`,
        };
      } catch (err) {
        return { name, state: "unchecked", detail: `${t.source} — ${(err as Error).message}` };
      }
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How many installed packages have nothing to say where their notes are,
 * without asking any forge — for the overview's one-line hint. A source counts
 * here even if it publishes nothing; `scan --unmapped` is where that is checked.
 */
export function unmappedCount(config: Config, installed: InstalledPackage[]): number {
  return installed.filter((p) => {
    const t = resolveTarget(p.name, config, installed);
    return !t.source && !t.page && !t.none;
  }).length;
}
