// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Release, ToolConfig } from "./types.ts";

const run = promisify(execFile);

/**
 * Strip ANSI SGR sequences before matching. Some CLIs colour their version
 * output even when stdout is not a TTY (`tea --version` prints the number in
 * bold), and those bytes would otherwise have to appear verbatim in every
 * `version.match` regex — working today and breaking the moment the tool stops
 * colouring, in a way that reads as "not installed".
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
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
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") return null;
    // A non-zero exit can still have printed the version (some tools exit 1 on
    // `--version` variants), so try the output before giving up.
    out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (!out.trim()) throw new Error(`${tool.name}: version probe failed: ${e.message}`);
  }
  const m = new RegExp(tool.version.match).exec(stripAnsi(out));
  if (!m?.[1]) {
    throw new Error(
      `${tool.name}: version.match /${tool.version.match}/ did not match output: ${out.trim().split("\n")[0]}`,
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
 * Releases strictly newer than `installed`, oldest first — so the digest reads
 * chronologically. When the installed version is unknown we only take the
 * newest release: dumping every release's notes for a tool you do not have
 * yet is noise, not a digest.
 */
export function releasesBehind(all: Release[], installed: string | null): Release[] {
  if (!installed) return all.slice(0, 1);
  return all.filter((r) => compareVersions(r.version, installed) > 0).reverse();
}
