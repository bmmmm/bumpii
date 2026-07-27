// SPDX-License-Identifier: GPL-3.0-or-later
import { type ExecError, run } from "./exec.ts";
import type { Release, ToolConfig } from "./types.ts";

/**
 * Strip ANSI SGR sequences before matching. Some CLIs colour their version
 * output even when stdout is not a TTY (`tea --version` prints the number in
 * bold), and those bytes would otherwise have to appear verbatim in every
 * `version.match` regex — working today and breaking the moment the tool stops
 * colouring, in a way that reads as "not installed".
 */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point — this matches the escape byte a CLI actually emits.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Ask the installed binary for its version. Returns null when the tool is not
 * installed at all, which is a normal state (a tool you track but have not put
 * on this machine yet), not an error.
 *
 * argv, never a shell string: a version probe is the last place that should be
 * able to run a second command because someone put a `;` in a config file.
 */
export async function installedVersion(tool: ToolConfig): Promise<string | null> {
  const [bin, ...args] = tool.version.cmd;
  if (!bin) throw new Error(`${tool.name}: version.cmd is empty`);
  let out: string;
  try {
    const r = await run(bin, args, { timeout: 10_000 });
    // Some CLIs print their version to stderr; `fj version` uses stdout, but
    // being wrong about that would silently report "not installed".
    out = `${r.stdout}\n${r.stderr}`;
  } catch (err) {
    const e = err as ExecError;
    if (e.code === "ENOENT") return null;
    // A non-zero exit can still have printed the version (some tools exit 1 on
    // `--version` variants), so try the output before giving up.
    out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (!out.trim()) throw new Error(`${tool.name}: version probe failed: ${e.message}`);
  }
  const m = new RegExp(tool.version.match).exec(stripAnsi(out));
  if (!m) {
    throw new Error(
      `${tool.name}: version.match /${tool.version.match}/ did not match output: ${out.trim().split("\n")[0]}`,
    );
  }
  // A pattern that matches but captures nothing is a different mistake from
  // one that does not match, and saying "did not match" sends you to rewrite
  // a regex that was already finding the right line.
  if (m[1] === undefined) {
    throw new Error(
      `${tool.name}: version.match /${tool.version.match}/ matched but captured nothing — put the version number in parentheses`,
    );
  }
  return m[1];
}

/** Numeric-segment comparison. Returns <0, 0, >0 like a sort comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    // Non-numeric segments (rc, beta) sort before a bare number of the same
    // position, which is enough for "is there something newer" — we never need
    // full semver precedence because prereleases are filtered out upstream.
    if (Number.isNaN(na) && Number.isNaN(nb)) continue;
    if (Number.isNaN(na)) return -1;
    if (Number.isNaN(nb)) return 1;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Whether a release carries a version that can be ordered at all.
 *
 * A tag like "nightly", "latest" or "continuous" produces an empty or
 * non-numeric version, and comparing it takes compareVersions straight into
 * the NaN branch — which answers "not newer" for everything and renders as a
 * confident "up to date". Filtering these out up front is what lets the report
 * distinguish "nothing pending" from "nothing comparable to compare against".
 */
export function isComparable(r: Release): boolean {
  return /^[0-9]/.test(r.version);
}

/**
 * The newest version that can actually be compared, or null when the forge
 * published none.
 *
 * Not simply `releases[0]`: a rolling pointer release outranks the numbered
 * one whenever it was republished more recently, and it is not a prerelease,
 * so nothing upstream filters it out. neovim ships exactly this — a `stable`
 * release alongside `v0.12.4`, both `"prerelease": false` — and taking the
 * head of the list yields an empty version, which renders as "0.12.2 → " with
 * nothing after the arrow.
 */
export function latestComparable(all: Release[]): string | null {
  return all.find(isComparable)?.version ?? null;
}

/**
 * Whether the fetched page ran out before the oldest pending release did.
 *
 * The signal is that every comparable release we saw is newer than what is
 * installed: the oldest one on the page is still ahead of you, so the page
 * boundary — not your version — is what ended the list. Only then does the
 * count understate the gap, and only then is a "+" honest.
 */
export function isTruncated(all: Release[], behind: Release[], capped: boolean): boolean {
  return capped && behind.length > 0 && behind.length === all.filter(isComparable).length;
}

/**
 * Releases strictly newer than `installed`, oldest first — so the digest reads
 * chronologically. When the installed version is unknown we only take the
 * newest release: dumping every release's notes for a tool you do not have
 * yet is noise, not a digest.
 */
export function releasesBehind(all: Release[], installed: string | null): Release[] {
  const comparable = all.filter(isComparable);
  if (!installed) return comparable.slice(0, 1);
  return comparable.filter((r) => compareVersions(r.version, installed) > 0).reverse();
}
