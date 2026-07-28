// SPDX-License-Identifier: GPL-3.0-or-later
// Fetch releases from a forge. Two API shapes cover everything we track:
// GitHub's, and Forgejo/Gitea's (which Codeberg and our own instance serve).
//
// Deliberately dependency-free: `fetch` is in the runtime, and a release list
// is a GET with a token header. Pulling an SDK for that would add a supply
// chain to a tool whose whole job is telling you what changed in your tools.
import type { Release } from "./types.ts";

export interface ForgeRef {
  kind: "github" | "forgejo";
  /** API base, e.g. "https://api.github.com" or "https://codeberg.org/api/v1". */
  api: string;
  /** "owner/repo" */
  repo: string;
}

/**
 * Strip whatever prefixes a tag so versions compare on their numbers alone.
 *
 * Not just a leading "v": jq tags releases `jq-1.8.2`, and leaving the name in
 * made every comparison fall into the non-numeric branch — which reported
 * "up to date" forever instead of erroring. Silently claiming a tool is
 * current is the one failure an update checker must not have.
 */
export function bare(tag: string): string {
  return tag.replace(/^[^0-9]*/, "");
}

/**
 * Parse "github:cli/cli", "codeberg:owner/repo", or a full forge URL
 * ("https://git.example.com/owner/repo"). The URL form assumes Forgejo/Gitea,
 * which is the only self-hosted shape we speak.
 */
export function parseSource(source: string): ForgeRef {
  if (source.startsWith("github:")) {
    return { kind: "github", api: "https://api.github.com", repo: source.slice(7) };
  }
  if (source.startsWith("codeberg:")) {
    return { kind: "forgejo", api: "https://codeberg.org/api/v1", repo: source.slice(9) };
  }
  if (source.startsWith("https://") || source.startsWith("http://")) {
    const u = new URL(source);
    // The URL form means Forgejo/Gitea, and nothing else speaks that API. A
    // GitLab URL used to be accepted and turned into /api/v1, which 404s with
    // a message about typos and tokens — sending the reader to check the
    // spelling of a URL that was spelled correctly. GitLab is /api/v4 with
    // different field names; refusing is honest, silently mis-parsing is not.
    if (/(^|\.)gitlab\./i.test(u.hostname)) {
      throw new Error(
        `${source} looks like GitLab, whose API bumpii does not speak (it talks GitHub and Forgejo/Gitea) — ` +
          `track this one by hand, or open an issue if you need GitLab support`,
      );
    }
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`source URL has no owner/repo path: ${source}`);
    // owner/repo are the LAST two segments, not the first two. Anything before
    // them is the instance's own base path — a Forgejo behind a reverse proxy
    // at /git/ is an ordinary deployment, and taking the segments from the
    // front would read the mount point as the owner and point /api/v1 at the
    // proxy root, where nothing answers.
    const repo = `${parts.at(-2)}/${parts.at(-1)?.replace(/\.git$/, "")}`;
    const prefix = parts.slice(0, -2).join("/");
    return { kind: "forgejo", api: `${u.origin}${prefix ? `/${prefix}` : ""}/api/v1`, repo };
  }
  throw new Error(
    `unrecognised source: ${source} — use "github:owner/repo", "codeberg:owner/repo", or a full https URL`,
  );
}

function authHeaders(ref: ForgeRef): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  // Only ever send a token to the host it belongs to. Sending GitHub's token
  // to a self-hosted forge is exactly the class of leak gh shipped in 2.93.0.
  if (ref.kind === "github") {
    const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (t) h.authorization = `Bearer ${t}`;
  } else if (ref.api.startsWith("https://codeberg.org")) {
    const t = process.env.CODEBERG_TOKEN;
    if (t) h.authorization = `token ${t}`;
  } else {
    const t = process.env.FORGEJO_TOKEN;
    if (t) h.authorization = `token ${t}`;
  }
  return h;
}

async function getJson(url: string, ref: ForgeRef): Promise<unknown> {
  const res = await fetch(url, { headers: authHeaders(ref) });
  if (!res.ok) {
    // 404 on a private repo without a token reads identically to a typo, so
    // say which of the two it might be rather than just echoing the status.
    const hint = res.status === 404 ? " (typo in the source, or private and no token set?)" : "";
    throw new Error(`${res.status} ${res.statusText} from ${url}${hint}`);
  }
  return res.json();
}

interface RawRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  url?: string;
  draft?: boolean;
  prerelease?: boolean;
}

function toRelease(r: RawRelease, ref: ForgeRef): Release {
  const tag = r.tag_name ?? r.name ?? "";
  return {
    tag,
    version: bare(tag),
    publishedAt: r.published_at ?? null,
    notes: (r.body ?? "").trim(),
    url: r.html_url ?? r.url ?? `${ref.api}/repos/${ref.repo}/releases`,
  };
}

/**
 * Map a forge URL to a bumpii source string. github.com and codeberg.org get
 * their shorthands; anything else Forgejo/Gitea-shaped keeps its full URL,
 * which parseSource turns into that host's /api/v1.
 *
 * The inverse of parseSource, so it lives beside it: every kind of discovery
 * arrives at a source this way — a formula's brew URLs, an image's OCI label,
 * whatever comes next — and none of them should have to import another
 * discovery module to do it.
 */
export function sourceFromUrls(urls: string[]): string | null {
  const text = urls.filter(Boolean).join(" ");
  const gh = /github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git|\/archive|\/releases|[\s/]|$)/.exec(text);
  if (gh?.[1]) return `github:${gh[1]}`;
  const cb = /codeberg\.org\/([^/\s]+\/[^/\s]+?)(?:\.git|\/archive|\/releases|[\s/]|$)/.exec(text);
  if (cb?.[1]) return `codeberg:${cb[1]}`;
  // gitea.com and self-hosted Forgejo/Gitea instances speak the same API — but
  // only accept hosts that plausibly ARE one. Plenty of formulae ship from a
  // plain tarball mirror whose path plausibly looks like owner/repo
  // (ftp.gnu.org/gnu/wget/…), and turning that into an /api/v1 source would
  // produce an entry that 404s on every run. Returning null instead sends the
  // user to the "add it by hand" message, which is recoverable.
  const other = /https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+?)(?:\.git|\/archive|\/releases|[\s/]|$)/.exec(text);
  const host = other?.[1] ?? "";
  const forgeLike = /^git\./.test(host) || /(gitea|forgejo|codeberg)/.test(host);
  if (other?.[2] && forgeLike) return `https://${host}/${other[2]}`;
  return null;
}

export interface ReleaseList {
  releases: Release[];
  /**
   * The forge returned as many as we asked for, so there are probably older
   * ones we never saw. Reported rather than assumed away: a tool thirty
   * versions behind would otherwise be described as exactly thirty, and this
   * is the one number in the report a person acts on.
   */
  capped: boolean;
}

/**
 * Newest-first list of published releases. Drafts and prereleases are dropped:
 * a prerelease is not something `brew upgrade` would ever hand you, so showing
 * its notes would describe changes you cannot get.
 */
export async function listReleases(ref: ForgeRef, limit = 30): Promise<ReleaseList> {
  const url =
    ref.kind === "github"
      ? `${ref.api}/repos/${ref.repo}/releases?per_page=${limit}`
      : `${ref.api}/repos/${ref.repo}/releases?limit=${limit}`;
  const raw = (await getJson(url, ref)) as RawRelease[];
  if (!Array.isArray(raw)) throw new Error(`unexpected release payload from ${url}`);
  return {
    // Capped on the raw page, before filtering: a full page of drafts still
    // means the forge had more to give.
    capped: raw.length >= limit,
    releases: raw.filter((r) => !r.draft && !r.prerelease).map((r) => toRelease(r, ref)),
  };
}
