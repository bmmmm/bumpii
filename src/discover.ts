// SPDX-License-Identifier: GPL-3.0-or-later
// Derive a tool entry from an installed Homebrew formula.
//
// Everything needed is already on the machine: brew knows the upstream tarball
// URL (hence the forge repo), which binaries the formula installs, and which
// version is current. The one thing brew cannot tell us is how the binary
// reports its own version — so we probe, and validate the probe against the
// version brew already knows. A guessed regex that happens to match nothing
// would silently make the tool look "not installed" forever; matching the
// known version is what makes the generated entry trustworthy.
import { readdir } from "node:fs/promises";
import { type ExecError, run, stripAnsi } from "./exec.ts";
import { sourceFromUrls } from "./sources.ts";
import type { ToolConfig } from "./types.ts";

export interface Discovery {
  formula: string;
  binary: string;
  version: string;
  source: string;
  entry: ToolConfig;
  /** How the version probe was confirmed, for the user to sanity-check. */
  probe: string;
}

/** Version-probe forms, in the order they are tried. The bare form goes last:
 * plenty of CLIs print usage when given nothing, but plenty of others open a
 * REPL — which is survivable only because exec.ts closes their stdin. */
const PROBES = [["--version"], ["version"], ["-V"], ["-v"], []];

async function brewJson(formula: string): Promise<Record<string, unknown>> {
  const { stdout } = await run("brew", ["info", "--json=v2", formula], { timeout: 60_000 });
  const d = JSON.parse(stdout) as { formulae?: Record<string, unknown>[] };
  const f = d.formulae?.[0];
  if (!f) throw new Error(`brew knows no formula "${formula}"`);
  return f;
}

// The prefix cannot change while the process runs, and `add` resolves it once
// per formula — memoised so a batch spawns one brew, not one per argument.
let cachedPrefix: Promise<string> | null = null;
function brewPrefix(): Promise<string> {
  cachedPrefix ??= run("brew", ["--prefix"], { timeout: 30_000 }).then((r) => r.stdout.trim());
  return cachedPrefix;
}

/** Binaries the formula installs, from its opt prefix (no `brew ls` — that
 * reads a cache path some sandboxes deny). */
async function binariesOf(formula: string): Promise<string[]> {
  const prefix = await brewPrefix();
  try {
    return await readdir(`${prefix}/opt/${formula}/bin`);
  } catch {
    return [];
  }
}

/**
 * Find a probe whose output contains the version brew reports, and build a
 * regex anchored on the surrounding text. Returns null when nothing matches —
 * better to say so than to write a config entry that never resolves.
 */
export async function confirmProbe(
  binary: string,
  known: string,
): Promise<{ cmd: string[]; match: string; probe: string } | null> {
  for (const args of PROBES) {
    let out = "";
    try {
      const r = await run(binary, args, { timeout: 10_000 });
      out = `${r.stdout}\n${r.stderr}`;
    } catch (err) {
      const e = err as ExecError;
      if (e.code === "ENOENT") return null;
      out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    // Strip colour before deriving the regex, or the escape bytes end up as
    // literals in it (see stripAnsi in exec.ts, which strips at match time).
    const line = stripAnsi(out)
      .split("\n")
      .find((l) => l.includes(known));
    if (!line) continue;

    // Anchor on the literal text before the version so the regex stays
    // specific: "gh version 2.96.0" -> /gh version ([0-9][0-9.]*)/ rather than
    // a bare number match that would also catch a date or a Go version.
    //
    // The line anchor matters most where that prefix is empty. fzf prints
    // "0.74.1 (Homebrew)" — nothing to anchor on — and installedVersion runs
    // the regex over the binary's whole output, not the matching line, so a
    // bare number pattern would take the first digits anywhere in it. The
    // prefix always starts at a line boundary, so anchoring is never wrong.
    const idx = line.indexOf(known);
    const prefixText = line.slice(0, idx);
    const escaped = prefixText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      cmd: [binary, ...args],
      match: `(?:^|\\n)${escaped}v?([0-9][0-9.]*)`,
      probe: `${[binary, ...args].join(" ")} → ${line.trim()}`,
    };
  }
  return null;
}

/**
 * Installed top-level formulae not yet in the config.
 *
 * `brew leaves` rather than `brew list`: leaves are what you asked for, the
 * rest are dependencies pulled in behind them, and nobody wants a digest of
 * libpng's release notes.
 *
 * Matching is by FORMULA name, taken from each entry's `brew upgrade <x>`
 * command — the config keys tools by binary name, and those differ often
 * enough (forgejo-cli ships `fj`) that matching on the key would keep
 * re-suggesting tools already tracked.
 */
export async function untrackedFormulae(trackedNames: Set<string>): Promise<string[]> {
  let leaves: string[];
  try {
    const { stdout } = await run("brew", ["leaves"], { timeout: 60_000 });
    leaves = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    throw new Error(`brew leaves failed: ${(err as Error).message}`);
  }
  // Tap-qualified names ("jundot/omlx/omlx") upgrade under their full name but
  // list under it too, so compare on the last path segment as well.
  const short = (s: string) => s.split("/").pop() ?? s;
  const tracked = new Set([...trackedNames, ...[...trackedNames].map(short)]);
  return leaves.filter((f) => !tracked.has(f) && !tracked.has(short(f)));
}

/** Build a ready-to-use tool entry for an installed formula. */
export async function discoverFormula(formula: string): Promise<Discovery> {
  const f = await brewJson(formula);
  const versions = (f.versions ?? {}) as { stable?: string };
  const version = versions.stable;
  if (!version) throw new Error(`${formula}: brew reports no stable version`);

  const urls = (f.urls ?? {}) as { stable?: { url?: string }; head?: { url?: string } };
  const source = sourceFromUrls([urls.stable?.url ?? "", urls.head?.url ?? "", (f.homepage as string) ?? ""]);
  if (!source) {
    throw new Error(
      `${formula}: no forge repo in its brew URLs — add it by hand with a "source" of "github:owner/repo" or a full forge URL`,
    );
  }

  const bins = await binariesOf(formula);
  // The formula name is often not the binary name (forgejo-cli ships `fj`),
  // so try every binary it installs and keep the first that reports a version.
  const candidates = bins.length > 0 ? bins : [formula];
  for (const binary of candidates) {
    const probe = await confirmProbe(binary, version);
    if (!probe) continue;
    return {
      formula,
      binary,
      version,
      source,
      probe: probe.probe,
      entry: {
        name: binary,
        source,
        version: { cmd: probe.cmd, match: probe.match },
        update: `brew upgrade ${formula}`,
      },
    };
  }
  throw new Error(
    `${formula}: none of its binaries (${candidates.join(", ")}) reported version ${version} — add the entry by hand`,
  );
}
