// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./types.ts";

export function configPath(): string {
  // `||`, never `??`: an exported-but-empty XDG_CONFIG_HOME is not a value, and
  // `??` only falls back on undefined — so `XDG_CONFIG_HOME=` made join("")
  // resolve relative to the working directory, putting tools.json and the
  // source cache wherever the command happened to be run from. AGENTS.md
  // states the same rule for process.stderr.columns; this is the second place
  // it applies.
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "bumpii", "tools.json");
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
    for (const field of ["name", "update"] as const) {
      if (typeof t?.[field] !== "string" || !t[field]) {
        throw new Error(`config: tools[${i}].${field} is required`);
      }
    }
    // `source` may be empty, unlike the others. `add --image` writes entries
    // for images that do not say which repo they came from, and an entry
    // waiting for that one line is more useful than no entry: everything else
    // about it is already worked out. The digest reports it as needing a
    // source rather than treating it as a failure.
    if (typeof t?.source !== "string") {
      throw new Error(`config: tools[${i}].source must be a string (empty if not known yet)`);
    }
    if (t.channel !== undefined) {
      if (typeof t.channel !== "string" || !t.channel) {
        throw new Error(`config: tools[${i}].channel must be a tag name like "tip"`);
      }
      // A channel names a tag in a repo; without a source there is no repo to
      // resolve it against, and the entry would sit there watching nothing.
      if (!t.source) {
        throw new Error(`config: tools[${i}].channel needs a source — the tag lives in that repo`);
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
  await writeDocument(doc, path);
  return added;
}

/** Fields safe to change from the CLI: the two an entry can be incomplete in. */
export const EDITABLE_FIELDS = ["source", "update"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Drop entries by name. Returns the names actually removed, so a caller can
 * tell "removed" from "was not there" — silently doing nothing is how you end
 * up thinking a tool is untracked when a typo left it in place.
 */
export async function removeTools(names: string[], path = configPath()): Promise<string[]> {
  const doc = await readDocument(path);
  const cfg = validate(doc);
  const wanted = new Set(names);
  const kept = cfg.tools.filter((t) => !wanted.has(t.name));
  const removed = cfg.tools.filter((t) => wanted.has(t.name)).map((t) => t.name);
  if (removed.length === 0) return [];
  doc.tools = kept;
  await writeDocument(doc, path);
  return removed;
}

/** Set one field on one entry. Throws when the tool is not tracked. */
export async function setToolField(
  name: string,
  field: EditableField,
  value: string,
  path = configPath(),
): Promise<void> {
  const doc = await readDocument(path);
  const cfg = validate(doc);
  const tool = cfg.tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`no tool named "${name}" in ${path} — see 'bumpii list'`);
  }
  tool[field] = value;
  doc.tools = cfg.tools;
  await writeDocument(doc, path);
}

/** Write via a temp file + rename, so a crash mid-write cannot tear the config. */
async function writeDocument(doc: Record<string, unknown>, path: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await rename(tmp, path);
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
