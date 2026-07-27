// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./types.ts";

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg ?? join(homedir(), ".config"), "bumpii", "tools.json");
}

/**
 * Shipped as the starting point rather than an empty file: the two CLIs this
 * was built for are already wired, so `bumpii init` produces something that
 * works before anything is edited.
 */
export const DEFAULT_CONFIG: Config = {
  usagePaths: ["~/.claude/skills", "~/ops/scripts", "~/dotfiles"],
  tools: [
    {
      name: "gh",
      source: "github:cli/cli",
      version: { cmd: ["gh", "--version"], match: "gh version ([0-9][0-9.]*)" },
      update: "brew upgrade gh",
    },
    {
      name: "fj",
      // forgejo-cli lives on Codeberg; the GitHub API does not know it.
      source: "codeberg:forgejo-contrib/forgejo-cli",
      // Not `fj --version` — that errors with "unexpected argument".
      version: { cmd: ["fj", "version"], match: "fj v?([0-9][0-9.]*)" },
      update: "brew upgrade forgejo-cli",
    },
  ],
};

function validate(cfg: unknown): Config {
  const c = cfg as Partial<Config>;
  if (!Array.isArray(c.tools)) throw new Error("config: `tools` must be an array");
  if (c.usagePaths !== undefined && !Array.isArray(c.usagePaths)) {
    throw new Error("config: `usagePaths` must be an array of paths");
  }
  for (const [i, t] of c.tools.entries()) {
    for (const field of ["name", "source", "update"] as const) {
      if (typeof t?.[field] !== "string" || !t[field]) {
        throw new Error(`config: tools[${i}].${field} is required`);
      }
    }
    if (!Array.isArray(t.version?.cmd) || t.version.cmd.length === 0) {
      throw new Error(`config: tools[${i}].version.cmd must be a non-empty argv array`);
    }
    if (typeof t.version?.match !== "string") {
      throw new Error(`config: tools[${i}].version.match must be a regex string`);
    }
    // Caught here rather than at probe time: a broken pattern otherwise
    // surfaces per tool, mid-run, as an error that never names the field.
    try {
      new RegExp(t.version.match);
    } catch (err) {
      throw new Error(`config: tools[${i}].version.match is not a valid regex — ${(err as Error).message}`);
    }
  }
  return { ...c, usagePaths: c.usagePaths ?? [], tools: c.tools };
}

/**
 * The config file as it is on disk, parsed but not reshaped.
 *
 * addTools writes this object back, so it has to be the whole document: this
 * is a hand-edited file the README invites you to edit, and rebuilding it from
 * the fields the current version happens to know deletes everything else in it
 * — a `$schema` line, a setting added by a newer release — without a word.
 */
async function readDocument(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no config at ${path} — run: bumpii init`);
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`config at ${path} is not valid JSON — ${(err as Error).message}`);
  }
}

export async function loadConfig(path = configPath()): Promise<Config> {
  return validate(await readDocument(path));
}

/**
 * Add entries to the config, keeping it sorted and never silently replacing an
 * existing tool — a tool you hand-tuned should survive a later `bumpii add`.
 * Returns the names actually added.
 */
export async function addTools(
  entries: import("./types.ts").ToolConfig[],
  path = configPath(),
): Promise<string[]> {
  const doc = await readDocument(path);
  // Validated before anything is written: refusing to rewrite a file we cannot
  // read correctly beats rewriting it into something we can.
  const cfg = validate(doc);
  const have = new Set(cfg.tools.map((t) => t.name));
  const added: string[] = [];
  for (const e of entries) {
    if (have.has(e.name)) continue;
    cfg.tools.push(e);
    have.add(e.name);
    added.push(e.name);
  }
  if (added.length === 0) return [];
  cfg.tools.sort((a, b) => a.name.localeCompare(b.name));
  doc.tools = cfg.tools;
  // Write via a temp file + rename: a config torn by a crash mid-write is the
  // kind of thing you only notice when the next run reports every tool gone.
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return added;
}

/** Write the default config. Never clobbers an existing one. */
export async function initConfig(path = configPath()): Promise<{ path: string; created: boolean }> {
  try {
    await readFile(path, "utf8");
    return { path, created: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return { path, created: true };
}
