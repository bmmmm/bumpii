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
 * CLI surface named in release notes, found without a model.
 *
 * The digest asks an engine which commands a change touches; this is the same
 * question answered mechanically, for people who have no engine at all. It is
 * deliberately cruder — it cannot tell a change from a heading — so what it
 * feeds is never described as a verdict, only as "these strings appear in both
 * the notes and your files", which is a claim it can actually support.
 *
 * Inline code spans are the whole source. Release notes across every project
 * mark up commands and flags with backticks, and a fenced block is usually a
 * whole example rather than the surface that changed.
 *
 * A span is kept only when it names the tool as a word. That drops `--json` on
 * its own — which would match half of anyone's scripts — and, on gh's real
 * 2.97.0 notes, drops `github_pat_*`, `ghs_*` and `ghu_*` while keeping
 * `gh attestation verify` and `gh auth status`. Over-reporting relevance is the
 * one direction this tool must not err in: a line that cries wolf trains you to
 * skip it, and then the real one goes unread too.
 */
export function commandsFromNotes(tool: string, notes: string): string[] {
  const word = new RegExp(
    `(^|[^A-Za-z0-9_-])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`,
  );
  const out = new Set<string>();
  for (const m of notes.matchAll(/`([^`\n]{2,120})`/g)) {
    const span = m[1]?.trim().replace(/\s+/g, " ");
    // Trailing punctuation belongs to the sentence, not the command, and would
    // be grepped verbatim.
    const cleaned = span?.replace(/[.,;:!?)\]]+$/, "").trim();
    if (cleaned && word.test(cleaned)) out.add(cleaned);
  }
  // The same specificity bar the model's output has to clear, applied here too:
  // three tokens or a flag. "gh api" is a group, not a surface.
  return toNeedles([...out]);
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

/**
 * Grep the user's own files for the commands of several tools at once.
 *
 * Fixed-string search (`grep -F`), not regex: the needles come from release
 * notes, where `gh pr view --json` or `foo[bar]` are ordinary text but would
 * be a broken or over-matching pattern. A command that appears nowhere is the
 * useful answer too — that is what lets the report say "affects you: none"
 * with something behind it.
 *
 * Every needle of every tool goes into ONE grep via repeated `-e`. Batching
 * across needles was always here; batching across tools is what this signature
 * adds, and it is the same saving one level up: the report walks ~/dotfiles
 * once per run rather than once per outdated package, which on a machine with
 * 23 of them pending was 23 full traversals of the same trees for one answer.
 * `-e` also means a needle that starts with a dash ("--json") can never be
 * read as an option.
 *
 * Results come back positionally, one list per input group, and a needle two
 * tools happen to share lands in both — exactly as separate greps would have
 * left it.
 */
export async function findUsageAcross(
  roots: string[],
  groups: readonly (readonly string[])[],
): Promise<{ hits: UsageHit[][]; incomplete?: string }> {
  const perGroup = groups.map((g) => toNeedles([...g]));
  const needles = [...new Set(perGroup.flat())];
  const empty = groups.map((): UsageHit[] => []);
  if (needles.length === 0 || roots.length === 0) return { hits: empty };

  let stdout: string;
  let incomplete: string | undefined;
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
    // grep exits 1 on "no matches" — that is a result, not a failure, and it
    // is the one that makes "affects you: none" mean something.
    //
    // Any other code is a failure, and the matches it did manage still arrive
    // on stdout, so they are kept. What changed is that the caller is told:
    // resolveUsagePaths catches a path that is missing before the run, but not
    // a directory this user may not read, not one that disappeared in between,
    // and not a kill on timeout or maxBuffer. Every one of those used to end
    // as a confident "none".
    const e = err as ExecError;
    if (e.code === 1 || e.code === "1") return { hits: empty };
    incomplete = whyIncomplete(e);
    stdout = e.stdout ?? "";
  }

  const all: UsageHit[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const [, file, lineNo, text] = m;
    // One grep for many needles means the match has to be attributed after the
    // fact — and a line may genuinely contain more than one.
    for (const needle of needles) {
      if (text?.includes(needle)) {
        all.push({ command: needle, file, line: Number.parseInt(lineNo, 10) });
      }
    }
  }
  // Split by filtering the shared list rather than by grouping on the needle,
  // so each group keeps the order grep produced. Grouping would reorder hits by
  // command, which is what the report prints them in.
  return {
    hits: perGroup.map((ns) => {
      const want = new Set(ns);
      return all.filter((h) => want.has(h.command));
    }),
    incomplete,
  };
}

/** The one-tool form of {@link findUsageAcross}. */
export async function findUsage(roots: string[], commands: string[]): Promise<UsageHit[]> {
  return (await findUsageAcross(roots, [commands])).hits[0] ?? [];
}
