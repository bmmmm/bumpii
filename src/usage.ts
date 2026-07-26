// SPDX-License-Identifier: GPL-3.0-or-later
// Turn "this release changed X" into "you call X in these files" — the part
// that makes the relevance verdict checkable instead of a model's opinion.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { UsageHit } from "./types.ts";

const run = promisify(execFile);

export function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

/**
 * Grep the user's own files for each extracted command string.
 *
 * Fixed-string search (`grep -F`), not regex: the needles come from release
 * notes, where `gh pr view --json` or `foo[bar]` are ordinary text but would
 * be a broken or over-matching pattern. A command that appears nowhere is the
 * useful answer too — that is what lets the report say "affects you: none"
 * with something behind it.
 */
export async function findUsage(paths: string[], commands: string[]): Promise<UsageHit[]> {
  // A needle has to be specific enough to mean something. "gh" or "gh pr"
  // matches half the user's scripts and would report "affects you" for a fix
  // to some unrelated subcommand — noise that trains you to ignore the line.
  // Three tokens ("gh pr view") or a flag ("gh pr --json") clears that bar.
  const needles = [
    ...new Set(
      commands
        .map((c) => c.trim().replace(/\s+/g, " "))
        .filter((c) => c.length >= 3 && (c.split(" ").length >= 3 || c.includes("-"))),
    ),
  ];
  if (needles.length === 0 || paths.length === 0) return [];

  const roots = paths.map(expandHome);
  const hits: UsageHit[] = [];

  for (const needle of needles) {
    let stdout = "";
    try {
      const r = await run(
        "grep",
        [
          "-rIn", // recursive, skip binaries, show line numbers
          "-F",
          needle,
          "--exclude-dir=.git",
          "--exclude-dir=node_modules",
          ...roots,
        ],
        { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      );
      stdout = r.stdout;
    } catch (err) {
      // grep exits 1 on "no matches" — that is a result, not a failure. Any
      // other code (2 = real error, e.g. unreadable path) is also non-fatal
      // here: a missing usage path should not sink the whole digest.
      const e = err as { code?: number | string; stdout?: string };
      if (e.code !== 1 && e.code !== "1") stdout = e.stdout ?? "";
      else continue;
    }
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const m = /^(.*?):(\d+):/.exec(line);
      if (!m) continue;
      hits.push({ command: needle, file: m[1]!, line: Number.parseInt(m[2]!, 10) });
    }
  }
  return hits;
}
