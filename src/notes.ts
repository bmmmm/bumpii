// SPDX-License-Identifier: GPL-3.0-or-later
// Where a package's release notes live, and reading them on demand.
//
// Three places can say it, in this order: a tracked entry's source, a hand-set
// mapping in tools.json's `packages`, and whatever brew's own URLs name. The
// first two exist because the third is often silent (a project that only
// keeps a NEWS file or a web page) — and `scan --unmapped` exists so that silence is listed rather than
// discovered the day someone asks.

import { namesOf } from "./config.ts";
import { run } from "./exec.ts";
import { caskSource, formulaSource, type RawInfoCask, type RawInfoFormula } from "./outdated.ts";
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
  /**
   * Installed on request (or a cask), not pulled in as a dependency. Only
   * these must have their notes mapped; a dependency can still be asked for.
   */
  requested: boolean;
}

type InfoFormula = RawInfoFormula & {
  versions?: { stable?: string };
  installed?: { installed_on_request?: boolean }[];
};
type InfoCask = RawInfoCask & { version?: string };

/**
 * Every installed formula and cask, in one `brew info`.
 *
 * Dependencies are included but marked: `notes` answers for them, while
 * `scan --unmapped` leaves them out — nobody maps the release notes of a
 * library they never asked for, and listing them as gaps would bury the
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
    if (!f.name) continue;
    out.push({
      name: f.name,
      kind: "formula",
      version: pageVersion(f.versions?.stable),
      derived: formulaSource(f),
      requested: f.installed?.at(-1)?.installed_on_request === true,
    });
  }
  for (const c of d.casks ?? []) {
    if (!c.token) continue;
    out.push({
      name: c.token,
      kind: "cask",
      version: pageVersion(c.version),
      derived: caskSource(c),
      requested: true,
    });
  }
  return out;
}

/**
 * A brew version as a release page is named: a cask's "4.4.1,abc123" carries
 * a build suffix after the comma that no page is named after, and "latest"
 * is not a version at all. Shared with overview.ts, which fills the same
 * templates from `brew outdated`'s numbers.
 */
export function pageVersion(raw: string | null | undefined): string | null {
  const v = raw?.split(",")[0]?.trim();
  return v && v !== "latest" ? v : null;
}

/** A page template with `{version}` filled, or the template and a flag when it cannot be. */
export function fillPage(template: string, version: string | null): { page: string; unfilled: boolean } {
  if (!template.includes("{version}")) return { page: template, unfilled: false };
  return version
    ? { page: template.replaceAll("{version}", version), unfilled: false }
    : { page: template, unfilled: true };
}

/** Everything known about where one name's notes are. */
export interface NotesTarget {
  name: string;
  source: string | null;
  /** The page with `{version}` filled in, or as written when no version is known. */
  page: string | null;
  /** The page needed a version and none was known, so `page` is the template. */
  pageUnfilled: boolean;
  /** The page is named after the version (`{version}`), so it is one release already. */
  pageVersioned: boolean;
  /** Brew's newest version, which a long page is cut to the section of. */
  version: string | null;
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
    // Tight on purpose: `q.includes(k)` on a two-letter name matched almost
    // any typo, and a list of dozens is not a suggestion.
    const q = name.toLowerCase();
    const near = known
      .filter((k) => {
        const l = k.toLowerCase();
        return (q.length >= 3 && l.includes(q)) || (l.length >= 4 && q.includes(l));
      })
      .sort((a, b) => Math.abs(a.length - q.length) - Math.abs(b.length - q.length) || a.localeCompare(b))
      .slice(0, 5);
    throw new Error(
      `no tool, mapped package or installed package named "${name}"` +
        (near.length ? ` — did you mean ${near.map((n) => `"${n}"`).join(", ")}?` : " — see 'bumpii list'"),
    );
  }
  const version = pkg?.version ?? null;
  const filled = mapping?.page ? fillPage(mapping.page, version) : null;
  return {
    name,
    source: tool?.source || mapping?.source || pkg?.derived || null,
    page: filled?.page ?? null,
    pageUnfilled: filled?.unfilled ?? false,
    pageVersioned: mapping?.page?.includes("{version}") ?? false,
    version,
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
 * installs a prerelease build under it, so its notes are the prereleases too
 * — read stable-only, they were older than what is installed.
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

/** What a page fetch may read at most, in bytes; longer is cut and said so. */
export const PAGE_CAP = 2 * 1024 * 1024;

/**
 * A release-notes page as text. Plain text (a NEWS file) passes through; HTML
 * is reduced by `pageText`. No token is sent anywhere — a page is not a forge.
 *
 * The body is read as a stream and abandoned at the cap, so a page that never
 * ends costs 2 MiB rather than whatever the server is willing to send. A body
 * that is not text (a PDF, an image) is refused rather than printed as
 * "text extracted".
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
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type && !/^text\/|html|xml|json|markdown/.test(type)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`not a text page — ${url} answered ${type.split(";")[0]}`);
  }
  const { bytes, truncated } = await readCapped(res, PAGE_CAP);
  const body = new TextDecoder().decode(bytes);
  const html = /html/.test(type) || (!/text\/plain/.test(type) && /<html|<body|<p[\s>]/i.test(body));
  return { text: (html ? pageText(body) : body).trim(), truncated };
}

/** At most `cap` bytes of a response body, and whether there was more. */
async function readCapped(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(await res.arrayBuffer()).slice(0, cap), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > cap) {
      chunks.push(value.subarray(0, cap - size));
      size = cap;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, truncated };
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

/** Dropped with their content, wherever they are. */
const DROP = new Set(["head", "script", "style", "noscript", "svg", "template", "iframe"]);
/** Page chrome: dropped too, but kept inside the selected main/article, where a header holds the title. */
const CHROME = new Set(["nav", "header", "footer", "aside"]);
const BLOCK_END = new Set([
  "p",
  "div",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "pre",
  "blockquote",
  "section",
  "table",
  "article",
  "main",
  "header",
]);

/**
 * The tag at `i` (which holds a `<`): its lowercased name, whether it closes,
 * and where it ends. Names keep their hyphens — `<nav-tabs>` is a custom
 * element, not a <nav>, and reading it as one once took the notes with it.
 * Null when `<` starts no tag (`a < b` in text); "open" when it starts one
 * that never ends — then no later `<` can either, and the rest is text.
 */
function tagAt(
  s: string,
  i: number,
): { name: string; close: boolean; empty: boolean; end: number } | null | "open" {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(i, i + 64));
  if (!m) return null;
  const end = s.indexOf(">", i);
  if (end === -1) return "open";
  // `<svg … />` has no content to drop: reading it as an open <svg> took the
  // page up to the next </svg> with it — or all of it, when none came.
  const empty = s[end - 1] === "/";
  return { name: (m[2] ?? "").toLowerCase(), close: m[1] === "/", empty, end: end + 1 };
}

/**
 * Where a dropped element's content ends, or null when it never does. `</head>`
 * is optional in HTML, so a head nothing closes ends where the body begins —
 * dropping the rest of the page there dropped the notes with it.
 */
function dropEnd(lower: string, name: string, from: number): number | null {
  const close = closingAt(lower, name, from);
  if (close) return close.end;
  if (name !== "head") return null;
  const body = lower.indexOf("<body", from);
  return body === -1 ? null : body;
}

/**
 * Where the element opened by a tag ending at `from` closes, or -1. Searched
 * in the lowercased copy, from that point on — one forward scan, never a
 * backtracking pattern, which is what kept this linear on pages that never
 * close what they open.
 */
function closingAt(lower: string, name: string, from: number): { start: number; end: number } | null {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at !== -1) {
    const next = lower[at + needle.length];
    if (next === ">" || next === " " || next === "\t" || next === "\n" || next === "\r" || next === "/") {
      const end = lower.indexOf(">", at);
      return { start: at, end: end === -1 ? lower.length : end + 1 };
    }
    at = lower.indexOf(needle, at + needle.length);
  }
  return null;
}

/**
 * HTML reduced to the text a person would read, without a parser.
 *
 * Page chrome goes, with its content — navigation, scripts and footers are
 * most of the bytes on a release page and none of the news. When the page
 * marks its content (`<main>`, `<article>`), only the first of them is kept;
 * the first article on a news page is the newest post. Block ends become line
 * breaks, so the result keeps the page's paragraphs and lists.
 *
 * One forward pass. The regex version before it backtracked on what a page
 * left unclosed: two megabytes of an unclosed `<script>` took over a minute,
 * and nothing could interrupt it. An element left open is dropped to the end
 * of the page, which is also what a page cut at the size cap needs.
 *
 * Control bytes are not this function's job: the renderer strips them from
 * everything of remote origin, entities decoded here included.
 */
export function pageText(html: string): string {
  let s = stripComments(html);
  let lower = s.toLowerCase();
  let inMain = false;
  const main = firstElement(s, lower, ["main", "article"]);
  if (main && /[^\s]/.test(textOnly(s.slice(main.start, main.end)))) {
    s = s.slice(main.start, main.end);
    lower = lower.slice(main.start, main.end);
    inMain = true;
  }
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, lt));
    // `<!DOCTYPE …>`, `<![CDATA[`, `<?xml …?>`: markup about the document,
    // never text in it.
    if (s[lt + 1] === "!" || s[lt + 1] === "?") {
      const gt = s.indexOf(">", lt);
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    const tag = tagAt(s, lt);
    // A `<` that opens no tag is text; a tag with no `>` after it ends the
    // markup, and what follows is dropped with it — asking each later `<`
    // for a `>` that is not there is what made this quadratic.
    if (tag === "open") break;
    if (!tag) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (!tag.close && !tag.empty && (DROP.has(tag.name) || (!inMain && CHROME.has(tag.name)))) {
      const end = dropEnd(lower, tag.name, i);
      if (end === null) break;
      i = end;
      continue;
    }
    if (tag.close) {
      if (BLOCK_END.has(tag.name)) out.push("\n");
    } else if (/^h[1-6]$/.test(tag.name)) out.push("\n\n");
    else if (tag.name === "li") out.push("\n- ");
    else if (tag.name === "br" || tag.name === "hr") out.push("\n");
  }
  return (
    decodeEntities(out.join(""))
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

/** HTML comments removed; one left open removes the rest. */
function stripComments(s: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = s.indexOf("<!--", i);
    if (at === -1) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, at));
    const end = s.indexOf("-->", at + 4);
    if (end === -1) break;
    i = end + 3;
  }
  return out.join("");
}

/** The inside of the first element of one of these names, or null. */
function firstElement(s: string, lower: string, names: string[]): { start: number; end: number } | null {
  let i = 0;
  for (;;) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) return null;
    const tag = tagAt(s, lt);
    if (tag === "open") return null;
    if (!tag) {
      i = lt + 1;
      continue;
    }
    // A `<main>` written inside a script or a template is a string, not the
    // page's content — skipped the same way the text pass skips it.
    if (!tag.close && !tag.empty && DROP.has(tag.name)) {
      const end = dropEnd(lower, tag.name, tag.end);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (!tag.close && names.includes(tag.name)) {
      const close = closingAt(lower, tag.name, tag.end);
      return { start: tag.end, end: close ? close.start : s.length };
    }
    i = tag.end;
  }
}

/** Text with every tag removed, for "does this element hold anything". Linear. */
function textOnly(s: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out.push(s.slice(i));
      return out.join("");
    }
    out.push(s.slice(i, lt));
    const gt = s.indexOf(">", lt);
    if (gt === -1) return out.join("");
    i = gt + 1;
  }
}

/** How much of a page `notes` shows, and why. */
export type PageScope =
  | { kind: "section"; matched: string; installed: string; from: number; to: number; total: number }
  | { kind: "all"; reason: "full" | "versioned" | "not-found" | "no-version"; total: number };

/**
 * The part of a changelog that belongs to one version: from the first line
 * naming it to the next line shaped the same way that names a version.
 *
 * "Shaped the same way" is the prefix before the version with its digits
 * blurred — `- Tool 4.441 [date]` ends at `- Tool 4.44 [date]`, and
 * `- 3/14/2025 version 2.2.0` at `- 9/2/2024 version 2.1.0` — so the
 * section ends where the page itself starts the next entry, without knowing
 * any page's layout. The version is tried whole and then by shorter prefixes,
 * because a NEWS file names `6.1` where brew installs `6.1.12`. Null when the
 * page never names it; the caller then shows all of it and says so.
 */
export function versionSection(
  text: string,
  version: string,
): { text: string; matched: string; from: number; to: number; total: number } | null {
  const lines = text.split("\n");
  // "2.4.7b" is what brew installs, "v2.4.7" what the page names — the
  // letter is tried off before any component is, or the fallback to "2.4"
  // lands on an older release.
  const bareVersion = version.replace(/[a-z]+$/i, "");
  const tries = [version];
  const parts = bareVersion.split(".");
  for (let k = parts.length; k >= 2; k--) tries.push(parts.slice(0, k).join("."));
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Every line's entry shapes, computed once. Asked per hit instead, the scan
  // re-blurred the rest of the page for each of up to fifty hits — measured at
  // 28 s on a hostile 2 MiB page, with the event loop (and Ctrl-C) blocked.
  const shapes = lines.map(lineShapes);
  const distinct = [...new Set(tries)];
  for (const [n, v] of distinct.entries()) {
    // Not followed by a letter or a `-word`: `3.5a` is not `3.5`, and
    // `2.0.0-rc1` is not `2.0.0` — the same pair `compareVersions` keeps apart.
    const own = new RegExp(`(?<![\\d.])${esc(v)}(?![\\da-zA-Z]|\\.\\d|-[a-zA-Z0-9])`);
    type Found = { text: string; matched: string; from: number; to: number; total: number };
    let first: Found | null = null;
    let open: Found | null = null;
    let seen = 0;
    for (let start = 0; start < lines.length && seen < 50; start++) {
      const startLine = lines[start] ?? "";
      const at = own.exec(startLine);
      if (!at) continue;
      seen++;
      const startShape = blur(startLine.slice(0, at.index));
      let end = lines.length;
      for (let j = start + 1; j < lines.length; j++) {
        if (shapes[j]?.has(startShape)) {
          end = j;
          break;
        }
      }
      // Trailing blank lines belong to the gap, not to the section.
      let to = end;
      while (to > start + 1 && !(lines[to - 1] ?? "").trim()) to--;
      const section = {
        text: lines.slice(start, to).join("\n"),
        matched: v,
        from: start + 1,
        to,
        total: lines.length,
      };
      // A line on its own is a table of contents naming the release, not the
      // release: the list of versions at the top of a changelog matches first
      // and ends at its next entry. A section that never meets a line shaped
      // like its own is a mention inside some entry ("crash in Tool 4.441"),
      // which would run to the end of the page. The real heading is closed by
      // the next release's — so that is the one taken, wherever it is.
      if (to - start > 1 && end < lines.length) return section;
      if (to - start > 1) open ??= section;
      first ??= section;
    }
    // A shorter version is a guess about where the installed one's notes are,
    // so only a section the page itself closes is good enough for it: "requires
    // 3.12 now" inside some entry is not the section for 3.12.1.
    const exact = n === 0 || (n === 1 && v === bareVersion);
    if (exact && (open ?? first)) return open ?? first;
  }
  return null;
}

/** A version-naming prefix with its digits blurred, so dates and numbers in it do not tell entries apart. */
function blur(prefix: string): string {
  return prefix.replace(/\d+/g, "#").trim();
}

/**
 * The shapes of the version-naming prefixes on one line. Long lines are prose,
 * not headings, and only the first few versions on a line are looked at — a
 * table of versions starts no entry.
 */
function lineShapes(line: string): Set<string> | null {
  if (line.length > 200) return null;
  let out: Set<string> | null = null;
  let k = 0;
  for (const m of line.matchAll(/(?<![\d.])\d+\.\d+(?:\.\d+)*[a-z]?(?![\d]|\.\d)/g)) {
    out ??= new Set();
    out.add(blur(line.slice(0, m.index)));
    if (++k >= 8) break;
  }
  return out;
}

/** What `bumpii notes` found, for the renderer and for --json. */
export interface NotesResult extends NotesTarget {
  releases: Release[];
  /** The forge could not be read; its own state, never folded into "no releases". */
  releasesError: string | null;
  /** A versioned formula whose branch had no release among those fetched. */
  branch: string | null;
  /** Installed from a prerelease channel, so prereleases are read too. */
  channel: string | null;
  pageText: string | null;
  /** What part of the page `pageText` is; null when no page text was read. */
  pageScope: PageScope | null;
  pageTruncated: boolean;
  pageError: string | null;
}

/**
 * Read the notes for a target: the forge's newest releases, and the page when
 * the forge had nothing to read — no source, an error, or bodies that are all
 * empty (some projects publish GitLab releases with no text at all).
 */
export async function readNotes(
  target: NotesTarget,
  opts: { last: number; full?: boolean },
): Promise<NotesResult> {
  const last = opts.last;
  const channel = prereleaseChannel(target.key);
  const result: NotesResult = {
    ...target,
    releases: [],
    releasesError: null,
    branch: null,
    channel,
    pageText: null,
    pageScope: null,
    pageTruncated: false,
    pageError: null,
  };
  if (target.source) {
    try {
      const list = await listReleases(parseSource(target.source), { prereleases: channel !== null });
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
      if (page.text) {
        const total = page.text.split("\n").length;
        const section =
          opts.full || target.pageVersioned || !target.version
            ? null
            : versionSection(page.text, target.version);
        result.pageText = section?.text ?? page.text;
        result.pageScope = section
          ? {
              kind: "section",
              matched: section.matched,
              installed: target.version ?? section.matched,
              from: section.from,
              to: section.to,
              total,
            }
          : {
              kind: "all",
              reason: opts.full
                ? "full"
                : target.pageVersioned
                  ? "versioned"
                  : target.version
                    ? "not-found"
                    : "no-version",
              total,
            };
      } else result.pageError = "the page had no readable text";
    } catch (err) {
      result.pageError = (err as Error).message;
    }
  }
  return result;
}

/** Whether anything readable came back. */
export function hasNotes(r: NotesResult): boolean {
  return r.releases.some((x) => x.notes) || Boolean(r.pageText);
}

/**
 * Whether the question was answered — the line between exit 0 and exit 2.
 * Notes shown answer it, and so does an acknowledged `none` when nothing else
 * had text: "this project publishes no notes" is the answer, not a failure —
 * also beside a source brew derives that only tags, the usual way a `none`
 * gets set. A forge or page that failed is no answer: it was not read.
 */
export function answered(r: NotesResult): boolean {
  return hasNotes(r) || (r.none !== null && !r.releasesError && !r.pageError);
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
 * The names whose notes must be mapped: every formula installed on request,
 * every cask, and every tracked tool brew did not install (an npm CLI, a
 * container). A tracked tool brew did install is its brew row. Shared by
 * `scan --unmapped` and the overview's count, which disagreed while each kept
 * its own list.
 */
export function coverageNames(config: Config, installed: InstalledPackage[]): string[] {
  const wanted = installed.filter((p) => p.requested);
  const names = wanted.map((p) => p.name);
  for (const t of config.tools)
    if (!namesOf(t).some((n) => wanted.some((p) => p.name === n))) names.push(t.name);
  return [...new Set(names)];
}

/**
 * Every package from `coverageNames`, sorted into what can be said about its
 * notes. A page counts as mapped without fetching it — unless it needs a
 * version brew does not know, in which case `notes` could not open it either.
 * A source counts once the forge has shown a release with text, because a
 * repo that tags without publishing releases is a source with nothing behind it.
 */
export async function coverage(config: Config, installed: InstalledPackage[]): Promise<CoverageRow[]> {
  const rows = await Promise.all(
    coverageNames(config, installed).map(async (name): Promise<CoverageRow> => {
      const t = resolveTarget(name, config, installed);
      if (t.page && !t.pageUnfilled) return { name, state: "mapped", detail: t.page };
      if (!t.source) {
        if (t.none) return { name, state: "none", detail: t.none };
        if (t.page)
          return { name, state: "no-notes", detail: `${t.page} — needs {version}, and brew reports none` };
        return { name, state: "unmapped", detail: "" };
      }
      try {
        // The same page `notes` reads, so the two never disagree about a
        // package: five was too few for a repo whose newest releases are all
        // prereleases, and read as "publishes no releases".
        const channel = prereleaseChannel(t.key);
        const list = await listReleases(parseSource(t.source), { prereleases: channel !== null });
        const { picked } = pickReleases(t.key, list.releases, list.releases.length);
        if (picked.some((r) => r.notes)) return { name, state: "mapped", detail: t.source };
        if (t.none) return { name, state: "none", detail: t.none };
        return {
          name,
          state: "no-notes",
          detail: `${t.source} — ${picked.length ? "its releases carry no text" : `no ${channel ? "" : "stable "}release among the newest it lists`}`,
        };
      } catch (err) {
        return { name, state: "unchecked", detail: `${t.source} — ${(err as Error).message}` };
      }
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How many of `coverageNames` have nothing to say where their notes are,
 * without asking any forge — for the overview's one-line hint. A source counts
 * here even if it publishes nothing; `scan --unmapped` is where that is checked.
 */
export function unmappedCount(config: Config, installed: InstalledPackage[]): number {
  return coverageNames(config, installed).filter((name) => {
    const t = resolveTarget(name, config, installed);
    return !t.source && !(t.page && !t.pageUnfilled) && !t.none;
  }).length;
}
