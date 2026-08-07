// SPDX-License-Identifier: GPL-3.0-or-later
// bumpii asks `gh` for a token when no env var carries one, which is what puts
// an ordinary run on 5000 requests/hour instead of 60.
//
// Its own file because that answer is resolved once per process: a test that
// needs gh to have a token and one that needs it to have none cannot share a
// process, and node:test gives each file its own.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const ghDir = mkdtempSync(join(tmpdir(), "bumpii-gh-"));
writeFileSync(join(ghDir, "gh"), "#!/bin/sh\n[ \"$1 $2\" = 'auth token' ] && echo gho_from_gh_cli\n");
chmodSync(join(ghDir, "gh"), 0o755);
const realPath = process.env.PATH;
process.env.PATH = ghDir;

const prevGithub = process.env.GITHUB_TOKEN;
const prevGh = process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

const { listReleases, parseSource } = await import("../src/sources.ts");

after(async () => {
  process.env.PATH = realPath;
  if (prevGithub !== undefined) process.env.GITHUB_TOKEN = prevGithub;
  if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
  await rm(ghDir, { recursive: true, force: true });
});

function stubFetch(): { calls: { url: string; headers: Record<string, string> }[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => [],
    };
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

test("with no env token, the request carries the one gh is logged in with", async () => {
  const stub = stubFetch();
  try {
    await listReleases(parseSource("github:o/r"));
    assert.equal(stub.calls[0]?.headers.authorization, "Bearer gho_from_gh_cli");
  } finally {
    stub.restore();
  }
});

test("gh's token is never sent to a forge it does not belong to", async () => {
  // The same rule the env vars follow, and the reason this is reached for only
  // on the github branch: a token that widens a GitHub limit has no business
  // reaching Codeberg or someone's self-hosted Forgejo.
  const stub = stubFetch();
  try {
    await listReleases(parseSource("codeberg:o/r"));
    await listReleases(parseSource("https://git.example.com/team/app"));
    for (const call of stub.calls) {
      assert.equal(call.headers.authorization, undefined, `${call.url} must go out unauthenticated`);
    }
  } finally {
    stub.restore();
  }
});
