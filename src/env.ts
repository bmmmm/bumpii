// SPDX-License-Identifier: GPL-3.0-or-later
// Where the local server's address and key come from.
//
// Order: process environment → this package's own .env → ~/.env. The package
// .env carries bumpii's per-app oMLX sub-key (written by ~/ops/scripts/omlx-keys);
// ~/.env carries the machine's shared values. Until 2026-09-25 only the
// environment was read, so a per-app key could never take effect.
//
// Two spellings are accepted: the generic OPENAI_BASE_URL / OPENAI_API_KEY
// (any OpenAI-compatible server) first, then oMLX's own OMLX_URL / OMLX_API_KEY,
// so the machine's ~/.env works without renaming its entries. A value is never
// put on a command line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `NAME=value` from a dotenv file (also `export NAME=…`, quotes and CR stripped); undefined when absent. */
export function dotenvValue(file: string, name: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^export\s+/, "").replace(/\r$/, "");
    if (!line.startsWith(`${name}=`)) continue;
    const value = line
      .slice(name.length + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (value) return value;
  }
  return undefined;
}

/** The first non-empty value of `name`: environment, then each file in order. */
export function resolveFrom(name: string, files: string[], env = process.env): string | undefined {
  if (env[name]) return env[name];
  for (const file of files) {
    const value = dotenvValue(file, name);
    if (value) return value;
  }
  return undefined;
}

/** BUMPII_DOTENV replaces the package .env (tests point it at a fixture); HOME moves ~/.env. */
const FILES = (): string[] => [
  process.env.BUMPII_DOTENV ?? join(PACKAGE_ROOT, ".env"),
  join(homedir(), ".env"),
];

/** Environment → <package>/.env → ~/.env. */
export function resolveEnv(name: string): string | undefined {
  return resolveFrom(name, FILES());
}

/** OPENAI_BASE_URL, else OMLX_URL; undefined when neither is configured anywhere. */
export function localServerBase(): string | undefined {
  return resolveEnv("OPENAI_BASE_URL") ?? resolveEnv("OMLX_URL");
}

/** OPENAI_API_KEY, else OMLX_API_KEY, else "local" (a server without auth). */
export function localServerKey(): string {
  return resolveEnv("OPENAI_API_KEY") ?? resolveEnv("OMLX_API_KEY") ?? "local";
}
