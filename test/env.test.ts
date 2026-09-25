// SPDX-License-Identifier: GPL-3.0-or-later
// Where the local server's key and address come from: the environment, then
// the package .env, then ~/.env — and the two spellings (OPENAI_*, OMLX_*).
// Every file here is a fixture in a temp dir; the real .env files are never read.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dotenvValue, localServerBase, localServerKey, resolveFrom } from "../src/env.ts";

const KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OMLX_API_KEY", "OMLX_URL", "BUMPII_DOTENV", "HOME"];

function isolated(): { dir: string; restore: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "bumpii-env-"));
  const prev: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = join(dir, "home");
  process.env.BUMPII_DOTENV = join(dir, "pkg.env");
  return {
    dir,
    restore: async () => {
      for (const k of KEYS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("dotenvValue: export prefix, quotes and CR are stripped; a missing file is undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "bumpii-dotenv-"));
  const f = join(dir, ".env");
  writeFileSync(f, "FOO=bar\nexport OMLX_API_KEY=\"k-1\"\r\nOMLX_URL='http://x/v1'\nOMLX_API_KEY_OLD=nope\n");
  assert.equal(dotenvValue(f, "OMLX_API_KEY"), "k-1");
  assert.equal(dotenvValue(f, "OMLX_URL"), "http://x/v1");
  assert.equal(dotenvValue(f, "MISSING"), undefined);
  assert.equal(dotenvValue(join(dir, "none"), "FOO"), undefined);
});

test("resolveFrom: environment first, then the files in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "bumpii-order-"));
  const a = join(dir, "a.env");
  const b = join(dir, "b.env");
  writeFileSync(a, "X=from-a\n");
  writeFileSync(b, "X=from-b\nY=from-b\n");
  assert.equal(resolveFrom("X", [a, b], { X: "from-env" }), "from-env");
  assert.equal(resolveFrom("X", [a, b], {}), "from-a");
  assert.equal(resolveFrom("Y", [a, b], {}), "from-b");
  assert.equal(resolveFrom("Z", [a, b], {}), undefined);
});

test("the package .env beats ~/.env, and OMLX_* fills in for OPENAI_*", async () => {
  const iso = isolated();
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(iso.dir, "home"));
    writeFileSync(join(iso.dir, "pkg.env"), "OMLX_API_KEY=omlx-bumpii-sub\n");
    writeFileSync(
      join(iso.dir, "home", ".env"),
      "OMLX_API_KEY=main-key\nOMLX_URL=http://127.0.0.1:8010/v1\n",
    );
    assert.equal(localServerKey(), "omlx-bumpii-sub", "the package .env wins over ~/.env");
    assert.equal(localServerBase(), "http://127.0.0.1:8010/v1", "~/.env fills what the package .env lacks");
    process.env.OPENAI_API_KEY = "explicit";
    process.env.OPENAI_BASE_URL = "http://other/v1";
    assert.equal(localServerKey(), "explicit", "OPENAI_* in the environment beats every file");
    assert.equal(localServerBase(), "http://other/v1");
  } finally {
    await iso.restore();
  }
});

test('nothing configured anywhere: no base, key falls back to "local"', async () => {
  const iso = isolated();
  try {
    assert.equal(localServerBase(), undefined);
    assert.equal(localServerKey(), "local");
  } finally {
    await iso.restore();
  }
});
