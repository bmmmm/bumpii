// SPDX-License-Identifier: GPL-3.0-or-later
// The forge layer, against a stubbed fetch: what gets filtered out, what the
// page boundary means, and whether a token can end up at the wrong host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listReleases, parseSource } from "../src/sources.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Replace global fetch with one that answers `body`, recording what it was asked. */
function stubFetch(body: unknown, status = 200): { calls: Call[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? "Not Found" : "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const release = (tag: string, over: Record<string, unknown> = {}) => ({
  tag_name: tag,
  body: `notes for ${tag}`,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  published_at: "2026-01-01T00:00:00Z",
  draft: false,
  prerelease: false,
  ...over,
});

test("listReleases drops drafts and prereleases", async () => {
  // A prerelease is not something `brew upgrade` would ever hand you, so its
  // notes would describe changes you cannot get.
  const stub = stubFetch([
    release("v2.0.0"),
    release("nightly", { prerelease: true }),
    release("v1.9.0", { draft: true }),
    release("v1.8.0"),
  ]);
  try {
    const { releases } = await listReleases(parseSource("github:o/r"));
    assert.deepEqual(
      releases.map((r) => r.version),
      ["2.0.0", "1.8.0"],
    );
  } finally {
    stub.restore();
  }
});

test("listReleases reports a full page as capped", async () => {
  const stub = stubFetch(Array.from({ length: 5 }, (_, i) => release(`v${i}.0.0`)));
  try {
    assert.equal((await listReleases(parseSource("github:o/r"), 5)).capped, true);
    assert.equal((await listReleases(parseSource("github:o/r"), 10)).capped, false);
  } finally {
    stub.restore();
  }
});

test("listReleases counts the page before filtering it", async () => {
  // Three released plus two drafts still means the forge had more to give;
  // judging capped on the filtered list would call that page complete.
  const stub = stubFetch([
    release("v3.0.0"),
    release("v2.0.0", { draft: true }),
    release("v1.0.0", { prerelease: true }),
  ]);
  try {
    const list = await listReleases(parseSource("github:o/r"), 3);
    assert.equal(list.releases.length, 1);
    assert.equal(list.capped, true);
  } finally {
    stub.restore();
  }
});

test("a 404 says which of the two things it probably is", async () => {
  // A private repo without a token reads identically to a typo.
  const stub = stubFetch([], 404);
  try {
    await assert.rejects(listReleases(parseSource("github:o/r")), /private and no token set/);
  } finally {
    stub.restore();
  }
});

test("a GitHub token never travels to a self-hosted forge", async () => {
  // This is the class of leak gh itself shipped in 2.93.0.
  const stub = stubFetch([]);
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "gh-token-value";
  try {
    await listReleases(parseSource("https://git.example.com/team/app"));
    const sent = JSON.stringify(stub.calls[0]?.headers ?? {});
    assert.doesNotMatch(sent, /gh-token-value/, "the GitHub token must not leave github.com");
    assert.match(stub.calls[0]?.url ?? "", /^https:\/\/git\.example\.com\/api\/v1\//);
  } finally {
    stub.restore();
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});

test("each forge shape gets its own paging parameter", async () => {
  const stub = stubFetch([]);
  try {
    await listReleases(parseSource("github:o/r"), 7);
    await listReleases(parseSource("codeberg:o/r"), 7);
    assert.match(stub.calls[0]?.url ?? "", /per_page=7/);
    assert.match(stub.calls[1]?.url ?? "", /limit=7/);
  } finally {
    stub.restore();
  }
});
