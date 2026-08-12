// SPDX-License-Identifier: GPL-3.0-or-later
// Fetch releases from a forge. Two API shapes cover everything we track:
// GitHub's, and Forgejo/Gitea's (which Codeberg and our own instance serve).
//
// Deliberately dependency-free: `fetch` is in the runtime, and a release list
// is a GET with a token header. Pulling an SDK for that would add a supply
// chain to a tool whose whole job is telling you what changed in your tools.
import { run } from "./exec.ts";
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
    if (parts.length < 2)
      throw new Error(
        `source URL has no owner/repo path: ${source} — it needs both, as in https://git.example.com/team/app`,
      );
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

/**
 * The token `gh` is already logged in with, if it is installed and logged in.
 *
 * 60 requests/hour is the ceiling this tool hits first, and anyone tracking
 * GitHub projects almost certainly has `gh` set up — sitting on 5000/hour that
 * a run had no way to use. Asking it is the same move the rest of this tool
 * makes: derive it from what is already on the machine rather than ask for a
 * second copy of something already configured.
 *
 * Resolved once per process, and never printed: it reaches the authorization
 * header and nothing else.
 */
let ghCliToken: Promise<string | null> | null = null;
function tokenFromGhCli(): Promise<string | null> {
  ghCliToken ??= run("gh", ["auth", "token"], { timeout: 5_000 })
    .then((r): string | null => r.stdout.trim() || null)
    // Not installed, not logged in, or refusing for any other reason — every
    // one of them means the same thing here: carry on unauthenticated.
    .catch((): string | null => null);
  return ghCliToken;
}

/**
 * Exported for inbox.ts, which PATCHes notification threads — the one write
 * this tool makes anywhere, and it must ride the same rule: the token goes to
 * the host it belongs to and nowhere else.
 */
export async function authHeaders(ref: ForgeRef): Promise<Record<string, string>> {
  const h: Record<string, string> = { accept: "application/json" };
  // Only ever send a token to the host it belongs to. Sending GitHub's token
  // to a self-hosted forge is exactly the class of leak gh shipped in 2.93.0 —
  // which is why gh's own token is reached for only on the github branch, and
  // never becomes a fallback for Codeberg or a self-hosted instance.
  //
  // An env var still wins. Someone who exported a deliberately narrow token
  // meant that one, and silently preferring whatever `gh` is logged in with
  // would widen the scope of every request without saying so.
  if (ref.kind === "github") {
    const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || (await tokenFromGhCli());
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

/**
 * Turn a rate-limit refusal into the one sentence that resolves it.
 *
 * GitHub answers an exhausted limit with 403 (or 429) and says so only in the
 * headers; the status line alone reads like a permissions problem, and sends
 * the reader to check a source that is spelled correctly. The reset time is
 * printed because the other half of the answer is "or just wait".
 */
async function rateLimitMessage(res: Response, ref: ForgeRef): Promise<string | null> {
  if (res.status !== 403 && res.status !== 429) return null;
  const remaining = res.headers.get("x-ratelimit-remaining");
  const retryAfter = res.headers.get("retry-after");
  if (remaining !== "0" && !retryAfter) return null;

  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toTimeString().slice(0, 5) : null;
  const envVar =
    ref.kind === "github"
      ? "GITHUB_TOKEN"
      : ref.api.startsWith("https://codeberg.org")
        ? "CODEBERG_TOKEN"
        : "FORGEJO_TOKEN";
  // What to do about it depends on whether the request was authenticated at
  // all, so the answer comes from the headers that were actually sent — which
  // on the github branch may be gh's token rather than anything the user set.
  const authed = Boolean((await authHeaders(ref)).authorization);
  const fix =
    ref.kind === "github"
      ? `set ${envVar}, or run 'gh auth login' — bumpii uses gh's token when it finds one (anonymous callers get 60 requests/hour)`
      : `set ${envVar} to raise it`;
  return (
    `rate limit exhausted at ${new URL(ref.api).host}${at ? `, resets at ${at}` : ""} — ` +
    (authed ? "this is that token's own limit; run fewer tools at once or wait" : fix)
  );
}

/**
 * Fetch a release list.
 *
 * Deliberately unconditional. An ETag cache was built here and measured
 * against the real API before being taken out again, because both halves of
 * its case turned out to be wrong: a 304 costs a rate-limit unit exactly like
 * a 200 (`remaining` fell by one for each, measured on cli/cli), and GitHub's
 * validator for `/releases` does not survive the gap between two runs — an
 * ETag ten minutes old was answered 200 while one fetched seconds earlier was
 * answered 304. For the cron-shaped use this tool is built around, a stored
 * validator would miss every time and buy a cache file for nothing.
 */
export async function getJson(url: string, ref: ForgeRef): Promise<unknown> {
  const res = await fetch(url, { headers: await authHeaders(ref) });
  if (!res.ok) {
    const limited = await rateLimitMessage(res, ref);
    if (limited) throw new Error(limited);
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

/** What a rolling channel holds beyond the installed build. */
export interface ChannelStatus {
  /** Head commit of the channel tag, abbreviated. */
  head: string;
  /** Commits between the installed build and the head; 0 means current. */
  aheadBy: number;
  /**
   * One synthetic release whose notes are the commit log, oldest first — so it
   * reads chronologically, like the release path. Null when current or when
   * the tool is not installed (there is nothing to compare from).
   */
  release: Release | null;
  /** The page ran out before the gap did: notes are the oldest slice of it. */
  truncated: boolean;
}

interface RawCommit {
  sha?: string;
  commit?: { message?: string; committer?: { date?: string } };
}

interface RawCompare {
  status?: string;
  ahead_by?: number;
  total_commits?: number;
  html_url?: string;
  commits?: RawCommit[];
}

/** ghostty prints nine hash characters in its own version string; match it. */
const shortSha = (sha: string) => sha.slice(0, 9);

/** The commit a channel tag currently points at. */
async function channelHead(ref: ForgeRef, tag: string): Promise<string> {
  const limit = ref.kind === "github" ? "per_page=1" : "limit=1";
  const url = `${ref.api}/repos/${ref.repo}/commits?sha=${encodeURIComponent(tag)}&${limit}`;
  const raw = (await getJson(url, ref)) as RawCommit[];
  const head = Array.isArray(raw) ? raw[0]?.sha : undefined;
  if (!head) {
    throw new Error(
      `no commits under "${tag}" at ${ref.repo} — is the channel tag spelled the way the forge spells it?`,
    );
  }
  return head;
}

/**
 * Where a rolling channel stands relative to the installed build.
 *
 * A channel like ghostty's "tip" is one mutable release whose notes never
 * change — the actual news is the commit log between the build you run and
 * the commit the tag points at now. The forge's compare endpoint answers both
 * halves at once: how far behind, and what landed in between. Both API shapes
 * this tool speaks serve the same path; Forgejo/Gitea omits `status` and
 * `ahead_by`, so those fall back to the commit list itself.
 */
export async function channelStatus(
  ref: ForgeRef,
  tag: string,
  installed: string | null,
): Promise<ChannelStatus> {
  // Nothing installed means nothing to compare from — report the head so the
  // entry still shows what it is watching, rather than an empty shrug.
  if (!installed) {
    return { head: shortSha(await channelHead(ref, tag)), aheadBy: 0, release: null, truncated: false };
  }

  const url =
    `${ref.api}/repos/${ref.repo}/compare/${encodeURIComponent(installed)}...${encodeURIComponent(tag)}` +
    (ref.kind === "github" ? "?per_page=250" : "");
  let raw: RawCompare;
  try {
    raw = (await getJson(url, ref)) as RawCompare;
  } catch (err) {
    // A 404 from compare is almost never a typo in the source — the release
    // path would have failed first. It means one endpoint of the range does
    // not exist: the probe captured something that is not a commit hash, the
    // tag is spelled differently, or the history it sat on was force-pushed.
    if (err instanceof Error && err.message.startsWith("404")) {
      throw new Error(
        `cannot compare ${installed}...${tag} at ${ref.repo} — the forge knows no such range; ` +
          `check that the version probe captures a commit hash and that "${tag}" is the channel's tag`,
      );
    }
    throw err;
  }

  // "diverged" is a real answer, not a failure of ours to parse: the installed
  // commit is not on the tag's history (a branch build, or a force-pushed
  // main). Counting commits "behind" against a history the build is not on
  // would be a number that means nothing.
  if (raw.status === "diverged") {
    throw new Error(
      `the installed build (${installed}) is not on ${tag}'s history at ${ref.repo} — ` +
        `a local or branch build cannot be measured against the channel`,
    );
  }

  const commits = Array.isArray(raw.commits) ? raw.commits : [];
  const aheadBy = raw.ahead_by ?? raw.total_commits ?? commits.length;
  // "identical" and "behind" both mean nothing is pending — being ahead of the
  // channel (a just-moved tag) is not something an update can fix.
  if (aheadBy === 0 || commits.length === 0) {
    return { head: shortSha(installed), aheadBy: 0, release: null, truncated: false };
  }

  const truncated = aheadBy > commits.length;
  // The page holds the oldest slice of the gap, so its last commit is only the
  // head when the gap fit — otherwise ask for the real one, or the report
  // would present a mid-gap commit as the latest build.
  const last = commits.at(-1);
  const head = truncated || !last?.sha ? await channelHead(ref, tag) : last.sha;
  const notes = commits
    .map((c) => `${c.sha ? shortSha(c.sha) : "?"} ${(c.commit?.message ?? "").split("\n")[0]}`)
    .join("\n");
  const root = ref.kind === "github" ? "https://github.com" : ref.api.replace(/\/api\/v1$/, "");
  return {
    head: shortSha(head),
    aheadBy,
    truncated,
    release: {
      tag,
      version: shortSha(head),
      publishedAt: last?.commit?.committer?.date ?? null,
      notes,
      url: raw.html_url ?? `${root}/${ref.repo}/compare/${installed}...${tag}`,
    },
  };
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
export async function listReleases(ref: ForgeRef, opts: { limit?: number } = {}): Promise<ReleaseList> {
  const { limit = 30 } = opts;
  const url =
    ref.kind === "github"
      ? `${ref.api}/repos/${ref.repo}/releases?per_page=${limit}`
      : `${ref.api}/repos/${ref.repo}/releases?limit=${limit}`;
  const raw = (await getJson(url, ref)) as RawRelease[];
  if (!Array.isArray(raw))
    throw new Error(
      `unexpected release payload from ${url} — it answered, but not with a release list; check that the ` +
        "source points at a forge and not at a web page in front of one",
    );
  return {
    // Capped on the raw page, before filtering: a full page of drafts still
    // means the forge had more to give.
    capped: raw.length >= limit,
    releases: raw.filter((r) => !r.draft && !r.prerelease).map((r) => toRelease(r, ref)),
  };
}
