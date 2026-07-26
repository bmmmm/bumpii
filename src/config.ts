// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
  }
  return {
    usagePaths: Array.isArray(c.usagePaths) ? c.usagePaths : [],
    tools: c.tools,
  };
}

export async function loadConfig(path = configPath()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no config at ${path} — run: bumpii init`);
    }
    throw err;
  }
  return validate(JSON.parse(raw));
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
