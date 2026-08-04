// SPDX-License-Identifier: GPL-3.0-or-later
// Turn "this release changed X" into "you call X in these files" — the part
// that makes the relevance verdict checkable instead of a model's opinion.
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type ExecError, run } from "./exec.ts";
import type { UsageHit } from "./types.ts";

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
 * Reduce extracted commands to needles specific enough to mean something.
 *
 * "gh" or "gh pr" matches half the user's scripts and would report "affects
 * you" for a fix to some unrelated subcommand — noise that trains you to
 * ignore the line. Three tokens ("gh pr view") or a flag ("gh pr --json")
 * clears that bar.
 */
export function toNeedles(commands: string[]): string[] {
  return [
    ...new Set(
      commands
        .map((c) => c.trim().replace(/\s+/g, " "))
        .filter((c) => c.length >= 3 && (c.split(" ").length >= 3 || /(^|\s)-/.test(c))),
    ),
  ];
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
export async function mentioned(roots: string[], names: string[]): Promise<Set<string>> {
  if (names.length === 0 || roots.length === 0) return new Set();
  let stdout: string;
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
    if (e.code === 1 || e.code === "1") return new Set();
    stdout = e.stdout ?? "";
  }
  return new Set(stdout.split("\n").filter(Boolean));
}

/**
 * Grep the user's own files for each extracted command string.
 *
 * Fixed-string search (`grep -F`), not regex: the needles come from release
 * notes, where `gh pr view --json` or `foo[bar]` are ordinary text but would
 * be a broken or over-matching pattern. A command that appears nowhere is the
 * useful answer too — that is what lets the report say "affects you: none"
 * with something behind it.
 *
 * All needles go into a single grep via repeated `-e`, rather than one grep
 * per needle: a digest of two dozen changes would otherwise walk the whole of
 * ~/dotfiles some fifty times over, per tool. `-e` also means a needle that
 * starts with a dash ("--json") can never be read as an option.
 */
export async function findUsage(roots: string[], commands: string[]): Promise<UsageHit[]> {
  const needles = toNeedles(commands);
  if (needles.length === 0 || roots.length === 0) return [];

  let stdout: string;
  try {
    const r = await run(
      "grep",
      [
        "-rIn", // recursive, skip binaries, show line numbers
        "-F",
        ...needles.flatMap((n) => ["-e", n]),
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        ...roots,
      ],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch (err) {
    // grep exits 1 on "no matches" — that is a result, not a failure. Paths
    // that do not exist are already filtered by resolveUsagePaths, so any
    // remaining exit 2 (an unreadable file mid-walk) still leaves the matches
    // it did find on stdout, and those are worth keeping.
    const e = err as ExecError;
    if (e.code === 1 || e.code === "1") return [];
    stdout = e.stdout ?? "";
  }

  const hits: UsageHit[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const [, file, lineNo, text] = m;
    // One grep for many needles means the match has to be attributed after the
    // fact — and a line may genuinely contain more than one.
    for (const needle of needles) {
      if (text?.includes(needle)) {
        hits.push({ command: needle, file, line: Number.parseInt(lineNo, 10) });
      }
    }
  }
  return hits;
}
