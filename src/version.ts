// SPDX-License-Identifier: GPL-3.0-or-later
import { type ExecError, run, stripAnsi } from "./exec.ts";
import type { Release, ToolConfig } from "./types.ts";

/**
 * Ask the installed binary for its version. Returns null when the tool is not
 * installed at all, which is a normal state (a tool you track but have not put
 * on this machine yet), not an error.
 *
 * argv, never a shell string: a version probe is the last place that should be
 * able to run a second command because someone put a `;` in a config file.
 */
/**
 * How long one version probe may take before it is abandoned.
 *
 * Exported because the progress line quotes it at the user — a number written
 * out twice is a number that will disagree with itself eventually.
 */
export const PROBE_TIMEOUT_MS = 10_000;

export async function installedVersion(tool: ToolConfig): Promise<string | null> {
  const [bin, ...args] = tool.version.cmd;
  if (!bin)
    throw new Error(
      `${tool.name}: version.cmd is empty — it is the argv that prints the version, e.g. ["gh", "--version"]`,
    );
  let out: string;
  let probeFailed = false;
  try {
    const r = await run(bin, args, { timeout: PROBE_TIMEOUT_MS });
    // Some CLIs print their version to stderr; `fj version` uses stdout, but
    // being wrong about that would silently report "not installed".
    out = `${r.stdout}\n${r.stderr}`;
  } catch (err) {
    const e = err as ExecError;
    if (e.code === "ENOENT") return null;
    // A non-zero exit can still have printed the version (some tools exit 1 on
    // `--version` variants), so try the output before giving up.
    probeFailed = true;
    out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (!out.trim()) throw new Error(`${tool.name}: version probe failed: ${e.message}`);
  }
  const m = new RegExp(tool.version.match).exec(stripAnsi(out));
  if (!m) {
    // Whether the probe itself failed decides where to send the reader. A
    // container entry whose container was removed reports "no such object" and
    // exits non-zero — blaming the regex there starts a hunt in the wrong file,
    // when the actual answer is that the thing being probed is gone.
    const first = out.trim().split("\n")[0];
    throw new Error(
      probeFailed
        ? `${tool.name}: the version probe failed and printed no version — is it still installed? (${bin}: ${first})`
        : `${tool.name}: version.match /${tool.version.match}/ did not match output: ${first}`,
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

/**
 * One dotted segment, split into the number it starts with and whatever
 * trailed it — "5a" is 5 followed by "a".
 *
 * A segment with no digits at all counts as zero, which is what keeps a
 * prerelease word from being read as a version number.
 */
function segment(s: string | undefined): { n: number; rest: string } {
  const m = /^([0-9]*)(.*)$/.exec(s ?? "");
  return { n: m?.[1] ? Number.parseInt(m[1], 10) : 0, rest: (m?.[2] ?? "").toLowerCase() };
}

/**
 * Split a version into the dotted core and the prerelease tail after the
 * first "-". Build metadata ("+abc") carries no precedence and is dropped.
 */
function parts(v: string): { core: string[]; pre: string } {
  const noBuild = v.split("+")[0] ?? "";
  const dash = noBuild.indexOf("-");
  const core = dash < 0 ? noBuild : noBuild.slice(0, dash);
  return { core: core.split("."), pre: dash < 0 ? "" : noBuild.slice(dash + 1).toLowerCase() };
}

/**
 * Segment comparison. Returns <0, 0, >0 like a sort comparator.
 *
 * The core splits on "." only, and "-" starts a prerelease tail — because
 * those two are opposite answers and one shared split erased the difference.
 * A letter riding on a segment continues the sequence ("3.5a" is tmux's
 * release after 3.5, "1.1.1w" is openssl's after 1.1.1t), while a word after a
 * dash precedes it ("1.0.0-rc1" comes before "1.0.0"). Sending both into
 * parseInt dropped the letter and answered "equal" for the first pair, and
 * equal is what renders as a green "up to date" over a pending release.
 *
 * Prereleases are filtered out upstream, so the tail rarely decides anything —
 * but `installedVersion` returns whatever the binary printed, which is not
 * filtered by anything.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const x = segment(pa.core[i]);
    const y = segment(pb.core[i]);
    if (x.n !== y.n) return x.n - y.n;
    // No suffix sorts before one that is there: 3.5 precedes 3.5a.
    if (x.rest !== y.rest) return x.rest < y.rest ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
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
  // The highest version, not the first one the API happened to list. GitHub
  // answers newest-first, so `find` was right until a repo republished an old
  // tag and moved it to the head — and this string is what the report prints
  // after the arrow, so reading position instead of order points it at a
  // version you are already past.
  const comparable = all.filter(isComparable);
  if (comparable.length === 0) return null;
  return comparable.reduce((best, r) => (compareVersions(r.version, best.version) > 0 ? r : best)).version;
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
