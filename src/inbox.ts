// SPDX-License-Identifier: GPL-3.0-or-later
// The releases GitHub already decided to tell you about.
//
// Watching a repo queues one notification per release — including the ones
// nothing else here can see: apps brew does not manage, npm-installed CLIs,
// and the prereleases a nightly channel actually runs on. This reads exactly
// that queue — unread notifications of type Release — and pushes the notes
// through the same judge-and-grep pipeline as everything else, so a pile of
// notifications shrinks to the lines that touch what you run.
import { digest, type Engine, isMechanical } from "./judge.ts";
import { limiter } from "./limit.ts";
import type { Progress } from "./progress.ts";
import { authHeaders, bare, type ForgeRef, getJson } from "./sources.ts";
import type { Config, DigestItem, Release, UsageHit } from "./types.ts";
import { commandsFromNotes, findUsageAcross, resolveUsagePaths } from "./usage.ts";

/** Notifications are a GitHub-only concept, so the ref never varies. */
const GITHUB: ForgeRef = { kind: "github", api: "https://api.github.com", repo: "" };

/**
 * One page. Fifty unread release notifications is already a neglected inbox;
 * paging further would spend rate limit describing a backlog the report cannot
 * make readable anyway. A full page is reported as capped instead.
 */
const PAGE = 50;

export interface InboxEntry {
  /** "owner/repo", as GitHub names it. */
  repo: string;
  /**
   * The word the notes are searched under: a tracked entry's name when a
   * tools.json source points at this repo (anthropics/claude-code is called
   * `claude`, not `claude-code`), else the repo's short name. For a repo whose
   * short name is not the binary either, the grep simply finds nothing — which
   * under-reports relevance and is the safe direction for a mechanical guess.
   */
  tool: string;
  tracked: boolean;
  /** The notified releases, oldest first — the order the digest reads. */
  releases: Release[];
  /** At least one of them is a prerelease. Shown, not filtered: brew will
   * never hand you one, but a subscription is the user saying they want these. */
  prerelease: boolean;
  /** Notification thread ids — what --mark-read patches. */
  threads: string[];
  items: DigestItem[];
  hits: UsageHit[];
  /** `hits` were read out of the notes mechanically, with no engine involved. */
  mechanical: boolean;
  /** The engine failed on these notes; the releases are still listed. */
  digestError?: string;
  /** The release bodies could not be fetched; nothing was shown, so
   * --mark-read leaves these threads unread. */
  error?: string;
}

export interface Inbox {
  entries: InboxEntry[];
  /**
   * Unread notifications that are not releases, counted by subject type.
   * Counted rather than dropped: "inbox zero" from a command that silently
   * ignored twelve issue threads would be claiming more than it checked.
   */
  other: Record<string, number>;
  /** The page was full, so the queue holds more than what is shown. */
  capped: boolean;
  missingUsagePaths: string[];
  /** The config names no usagePaths at all — nothing was searched, so every
   * "affects you" would otherwise assert absence about an empty search. */
  noUsagePaths: boolean;
  /**
   * grep did not get to the end of the walk, so every "affects you" below is a
   * floor rather than the answer. One grep serves the whole run, which is why
   * this sits here and not on each entry.
   */
  usageIncomplete?: string;
  engine: Engine;
}

interface RawNotification {
  id?: string;
  subject?: { title?: string; url?: string | null; type?: string };
  repository?: { full_name?: string };
}

interface RawReleaseBody {
  tag_name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
}

/**
 * The unread notifications, or the one sentence that explains why not:
 * /notifications is the rare GitHub endpoint with no anonymous form at all,
 * so a 401 here is not a degraded mode — it is the whole command refusing.
 */
async function notifications(): Promise<RawNotification[]> {
  try {
    const raw = await getJson(`${GITHUB.api}/notifications?per_page=${PAGE}`, GITHUB);
    if (!Array.isArray(raw)) throw new Error(`unexpected payload from ${GITHUB.api}/notifications`);
    return raw as RawNotification[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/^401 /.test(msg)) {
      throw new Error(
        "reading your notifications needs a GitHub token (none was found, or it was refused) — " +
          "run 'gh auth login', or set GITHUB_TOKEN",
      );
    }
    throw err;
  }
}

/** Repos a tools.json entry already points at, keyed lowercase → entry name. */
function trackedRepos(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of config.tools) {
    if (t.source.startsWith("github:")) m.set(t.source.slice(7).toLowerCase(), t.name);
  }
  return m;
}

export interface InboxOptions {
  engine: Engine;
  /** How many repos may be judged at once. */
  concurrency: number;
  /** Where to report which part of this is running. Counts come from the run. */
  progress?: Progress;
}

export async function buildInbox(config: Config, opts: InboxOptions): Promise<Inbox> {
  const progress = opts.progress;
  const usage = await resolveUsagePaths(config.usagePaths);
  progress?.phase("notifications");
  const raw = await notifications();

  // Group release threads by repo: three claude-code releases are one entry
  // with three releases, exactly as the digest shows a tool three behind —
  // one digest over all of them, not three reports about one repo.
  const byRepo = new Map<string, { threads: string[]; urls: string[] }>();
  const other: Record<string, number> = {};
  for (const n of raw) {
    const repo = n.repository?.full_name;
    const url = n.subject?.url;
    if (n.subject?.type !== "Release" || !repo || !url) {
      const type = n.subject?.type ?? "unknown";
      other[type] = (other[type] ?? 0) + 1;
      continue;
    }
    let g = byRepo.get(repo);
    if (!g) {
      g = { threads: [], urls: [] };
      byRepo.set(repo, g);
    }
    if (n.id) g.threads.push(n.id);
    if (!g.urls.includes(url)) g.urls.push(url);
  }

  const tracked = trackedRepos(config);
  const limitJudge = limiter(opts.concurrency);

  let finished = 0;
  const done = (): void => progress?.set({ done: ++finished });
  progress?.phase("fetch", { total: byRepo.size, done: 0, tools: byRepo.size });

  // Two passes, same as the digest and the overview: everything each entry can
  // say on its own, then ONE grep for the commands all of them extracted.
  const built = await Promise.all(
    [...byRepo.entries()].map(async ([repo, g]): Promise<{ entry: InboxEntry; commands: string[] }> => {
      const name = tracked.get(repo.toLowerCase()) ?? repo.split("/").pop() ?? repo;
      const base: InboxEntry = {
        repo,
        tool: name,
        tracked: tracked.has(repo.toLowerCase()),
        releases: [],
        prerelease: false,
        threads: g.threads,
        items: [],
        hits: [],
        mechanical: false,
      };
      try {
        const bodies = await Promise.all(
          g.urls.map(async (u) => (await getJson(u, GITHUB)) as RawReleaseBody),
        );
        const releases: Release[] = bodies
          .map((r) => {
            const tag = r.tag_name ?? "";
            return {
              tag,
              version: bare(tag),
              publishedAt: r.published_at ?? null,
              notes: (r.body ?? "").trim(),
              url: r.html_url ?? `https://github.com/${repo}/releases`,
            };
          })
          .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));

        // A digest that fails costs the summary, not the news — the same
        // split the digest command makes, for the same reason.
        let items: DigestItem[] = [];
        let digestError: string | undefined;
        if (releases.length > 0 && opts.engine.kind !== "none") {
          progress?.phase("judge", {
            total: byRepo.size,
            done: finished,
            tools: byRepo.size,
            concurrency: opts.concurrency,
          });
        }
        try {
          items = await limitJudge(() => digest(opts.engine, name, releases));
        } catch (err) {
          digestError = err instanceof Error ? err.message : String(err);
        }
        // Same shared predicate the digest and overview paths use: a release
        // the forge published with an empty body was never read, so claiming
        // a mechanical read over it describes a pass over no text.
        const mechanical = isMechanical(items.length, releases);
        return {
          entry: {
            ...base,
            releases,
            prerelease: bodies.some((r) => Boolean(r.prerelease)),
            items,
            mechanical,
            digestError,
          },
          commands: mechanical
            ? releases.flatMap((r) => commandsFromNotes(name, r.notes))
            : items.flatMap((i) => i.commands),
        };
      } catch (err) {
        return {
          entry: { ...base, error: err instanceof Error ? err.message : String(err) },
          commands: [],
        };
      } finally {
        done();
      }
    }),
  );

  progress?.phase("grep", {
    commands: built.reduce((n, b) => n + b.commands.length, 0),
    roots: usage.roots.length,
  });
  const search = await findUsageAcross(
    usage.roots,
    built.map((b) => b.commands),
  );
  // Kept in notification order — GitHub lists newest first, and an inbox that
  // re-sorted by name would bury this morning's release under the alphabet.
  const entries = built.map((b, i) => ({ ...b.entry, hits: search.hits[i] ?? [] }));

  return {
    entries,
    other,
    capped: raw.length >= PAGE,
    missingUsagePaths: usage.missing,
    noUsagePaths: config.usagePaths.length === 0,
    usageIncomplete: search.incomplete,
    engine: opts.engine,
  };
}

/**
 * The threads --mark-read may touch: entries whose releases were actually
 * shown. An entry whose release bodies could not be fetched showed nothing,
 * and marking its thread read would delete the only reminder it exists.
 */
export function shownThreads(entries: InboxEntry[]): string[] {
  return entries.filter((e) => !e.error).flatMap((e) => e.threads);
}

/**
 * Mark exactly these threads read. Per thread, never `PUT /notifications`:
 * the whole-inbox form would also sweep the issue and PR threads this command
 * deliberately does not cover. Returns the failures instead of throwing, so
 * one refused thread does not abort the rest.
 */
export async function markThreadsRead(threadIds: string[]): Promise<string[]> {
  const failures: string[] = [];
  await Promise.all(
    threadIds.map(async (id) => {
      try {
        const res = await fetch(`${GITHUB.api}/notifications/threads/${id}`, {
          method: "PATCH",
          headers: await authHeaders(GITHUB),
        });
        if (!res.ok) failures.push(`thread ${id}: HTTP ${res.status}`);
      } catch (err) {
        failures.push(`thread ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
  return failures;
}
