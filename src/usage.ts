// SPDX-License-Identifier: GPL-3.0-or-later
// Turn "this release changed X" into "you call X in these files" — the part
// that makes the relevance verdict checkable instead of a model's opinion.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type ExecError, run } from "./exec.ts";

export function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export interface UsageRoots {
  /** Configured paths that exist and can be searched. */
  roots: string[];
  /** Configured paths that do not — reported, never silently dropped. */
  missing: string[];
}

/**
 * What to tell the user about a grep that did not get to the end.
 *
 * Every search below returns this beside its result, because grep exits 1 for
 * "no matches" — a result, and often the interesting one — and 2 for a real
 * failure: a root that vanished between the stat and the walk, a directory
 * this user may not read, a kill on timeout or maxBuffer. Both used to arrive
 * at the caller as an empty list, and an empty list is what the report prints
 * as "affects you: none". That is this tool's central claim, and making it
 * about a search that never happened is the exact shape of quiet wrong answer
 * everything else here is built to avoid.
 *
 * Whatever matches did arrive are still kept and still shown; the reason says
 * they are a floor rather than the answer, which is a different statement from
 * having found nothing.
 *
 * grep's own first line names the path it could not read, which is the only
 * actionable part; a kill prints nothing at all, so the error's message stands
 * in for it.
 */
function whyIncomplete(e: ExecError): string {
  const first = (e.stderr ?? "").trim().split("\n")[0]?.trim();
  return first || e.message;
}

/**
 * Split the configured usage paths into searchable and missing.
 *
 * "affects you: none" is this tool's central claim, and a path that does not
 * exist produces exactly that answer with nothing behind it. grep reports the
 * failure (exit 2), but mixed in with the perfectly normal "no matches" (exit
 * 1) — so the check happens here instead, once, where the result can be shown.
 */
export async function resolveUsagePaths(paths: string[]): Promise<UsageRoots> {
  const roots: string[] = [];
  const missing: string[] = [];
  await Promise.all(
    paths.map(async (p) => {
      const abs = expandHome(p);
      try {
        await stat(abs);
        roots.push(abs);
      } catch {
        missing.push(p);
      }
    }),
  );
  return { roots, missing };
}

/**
 * Which of these names appear anywhere in the user's own files.
 *
 * The same grep the report runs, asked the other way round — and it is what
 * `scan --unref` is allowed to claim: a name that appears nowhere means no
 * script of yours calls it, which is not the same statement as "you never use
 * it". Nothing here can see an interactive shell, and the tool does not read
 * shell history to pretend otherwise.
 *
 * Deliberately substring, not word-boundary (`grep -w`): matching "jq" inside
 * "jquery" over-reports the name as mentioned, and that is the safe direction.
 * The claim being made is the absence one, so a false "mentioned" costs a
 * candidate while a false "unmentioned" would be exactly the confident wrong
 * answer this tool exists not to give.
 *
 * `-o` prints the matched strings rather than the lines holding them: a name
 * as common as "tree" would otherwise return most of a dotfiles repo, and only
 * which names matched is wanted here.
 */
export async function mentioned(
  roots: string[],
  names: string[],
): Promise<{ names: Set<string>; incomplete?: string }> {
  if (names.length === 0 || roots.length === 0) return { names: new Set() };
  let stdout: string;
  let incomplete: string | undefined;
  try {
    const r = await run(
      "grep",
      [
        "-rohI", // recursive, matched part only, no filenames, skip binaries
        "-F",
        ...names.flatMap((n) => ["-e", n]),
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        ...roots,
      ],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (err) {
    // Exit 1 is "no matches", a result rather than a failure — and here it is
    // the interesting one: nothing you have is named in anything you wrote.
    const e = err as ExecError;
    if (e.code === 1 || e.code === "1") return { names: new Set() };
    // Anything else is a failure, and "no file of yours names this" is an
    // absence claim — the one kind of answer a half-finished search must not
    // be allowed to produce silently.
    incomplete = whyIncomplete(e);
    stdout = e.stdout ?? "";
  }
  return { names: new Set(stdout.split("\n").filter(Boolean)), incomplete };
}

/**
 * How many of your files name each of these, one file counted once per name.
 *
 * Word-boundary (`grep -w`), and deliberately the opposite call from
 * `mentioned` above. That one is making an absence claim, where over-reporting
 * is the safe direction; this one produces a ranking, where it is not.
 * Measured rather than assumed: on one real set of usagePaths a three-letter
 * tool name matched over three times as many files as a substring ("tea" inside
 * "instead", "team") as it did as a word, which would have ranked it above
 * tools genuinely called far more often. `-w` costs the odd real hit inside a
 * compound word, which moves a number rather than inventing one.
 *
 * `-o` keeps the output to the matched names instead of whole lines — a name as
 * common as "node" would otherwise return most of a dotfiles repo — and `-H`
 * forces the filename even when a single root is searched, so the two halves of
 * every line are always in the same place.
 */
export async function referenceCounts(
  roots: string[],
  names: string[],
): Promise<{ counts: Map<string, number>; incomplete?: string }> {
  const counts = new Map(names.map((n) => [n, 0]));
  if (names.length === 0 || roots.length === 0) return { counts };

  let stdout: string;
  let incomplete: string | undefined;
  try {
    const r = await run(
      "grep",
      [
        "-rwoIH", // recursive, whole words, matched part only, with filename, skip binaries
        "-F",
        ...names.flatMap((n) => ["-e", n]),
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        ...roots,
      ],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (err) {
    const e = err as ExecError;
    if (e.code === 1 || e.code === "1") return { counts };
    // A zero from a walk that stopped early ranks a package as unused, which
    // is what decides whether overview bothers to judge it at all.
    incomplete = whyIncomplete(e);
    stdout = e.stdout ?? "";
  }

  const files = new Map<string, Set<string>>();
  for (const line of stdout.split("\n")) {
    // Split at the LAST colon: a path may contain one, a package name never
    // does, so everything before the final colon is the file.
    const idx = line.lastIndexOf(":");
    if (idx < 1) continue;
    const file = line.slice(0, idx);
    const name = line.slice(idx + 1);
    if (!counts.has(name)) continue;
    let seen = files.get(name);
    if (!seen) {
      seen = new Set();
      files.set(name, seen);
    }
    seen.add(file);
  }
  for (const [name, seen] of files) counts.set(name, seen.size);
  return { counts, incomplete };
}
