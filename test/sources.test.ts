// SPDX-License-Identifier: GPL-3.0-or-later
// The forge layer, against a stubbed fetch: what gets filtered out, what the
// page boundary means, and whether a token can end up at the wrong host.
//
// `gh` is stubbed away for the whole file before anything runs. sources.ts asks
// it for a token when no env var carries one, and it resolves that once per
// process — so without this, whether these tests see an authenticated request
// would depend on whether the machine running them happens to be logged in.
// The gh path has its own file, where that one answer can be the point.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const ghDir = mkdtempSync(join(tmpdir(), "bumpii-nogh-"));
writeFileSync(join(ghDir, "gh"), "#!/bin/sh\nexit 1\n");
chmodSync(join(ghDir, "gh"), 0o755);
const realPath = process.env.PATH;
process.env.PATH = ghDir;

const { channelStatus, listReleases, parseSource } = await import("../src/sources.ts");

after(async () => {
  process.env.PATH = realPath;
  await rm(ghDir, { recursive: true, force: true });
});

interface Call {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}

/**
 * Replace global fetch with one that answers `body`, recording what it was
 * asked. Response headers are a real `Headers`, because the code under test
 * reads the rate-limit fields off them — a plain object would pass here and
 * throw against the runtime.
 */
function stubFetch(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): { calls: Call[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? "Not Found" : "OK",
      headers: new Headers(headers),
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

test("a forge under a base path keeps it, and owner/repo stay the last two segments", async () => {
  // A Forgejo proxied at /git/ is an ordinary deployment. Reading the segments
  // from the front makes "git" the owner and points /api/v1 at the proxy root.
  assert.deepEqual(parseSource("https://example.com/git/team/app"), {
    kind: "forgejo",
    api: "https://example.com/git/api/v1",
    repo: "team/app",
  });
  assert.deepEqual(parseSource("https://example.com/forge/inner/team/app.git"), {
    kind: "forgejo",
    api: "https://example.com/forge/inner/api/v1",
    repo: "team/app",
  });
});

test("a GitLab URL is refused rather than parsed as Forgejo", async () => {
  // It used to become https://gitlab.com/api/v1, which 404s with a message
  // about typos and missing tokens — the URL was fine, the API is simply a
  // different one. GitLab is /api/v4 with different field names.
  assert.throws(() => parseSource("https://gitlab.com/owner/repo"), /looks like GitLab/);
  assert.throws(() => parseSource("https://gitlab.example.com/team/app"), /does not speak/);
  assert.throws(() => parseSource("https://gitlab.com/owner/repo"), /track this one by hand/);
});

test("a host merely containing 'gitlab' in a path is unaffected", () => {
  // The check is on the hostname, so a Forgejo instance serving a repo called
  // "gitlab-migration" keeps working.
  assert.deepEqual(parseSource("https://git.example.com/team/gitlab-migration"), {
    kind: "forgejo",
    api: "https://git.example.com/api/v1",
    repo: "team/gitlab-migration",
  });
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
    assert.equal((await listReleases(parseSource("github:o/r"), { limit: 5 })).capped, true);
    assert.equal((await listReleases(parseSource("github:o/r"), { limit: 10 })).capped, false);
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
    const list = await listReleases(parseSource("github:o/r"), { limit: 3 });
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

test("a Codeberg token never travels to a host merely named like Codeberg", async () => {
  // The check was `ref.api.startsWith("https://codeberg.org")`, a string
  // prefix rather than a host, so "codeberg.org.evil.tld" and even
  // "codeberg.orgevil.tld" matched. Measured against the real function before
  // the fix: authHeaders returned `token CB-SECRET` for both.
  //
  // Reachable without touching the config: sourceFromUrls gated on a substring
  // too, so a formula homepage or an OCI image.source label — neither of them
  // written by the user — was enough to plant the host.
  const prev = process.env.CODEBERG_TOKEN;
  process.env.CODEBERG_TOKEN = "cb-token-value";
  try {
    for (const host of ["codeberg.org.evil.tld", "codeberg.orgevil.tld", "evil.tld"]) {
      const stub = stubFetch([]);
      try {
        await listReleases(parseSource(`https://${host}/o/r`));
        const sent = JSON.stringify(stub.calls[0]?.headers ?? {});
        assert.doesNotMatch(sent, /cb-token-value/, `${host} is not codeberg.org`);
      } finally {
        stub.restore();
      }
    }
    // And the real host still gets it, or the fix is just a removal.
    const stub = stubFetch([]);
    try {
      await listReleases(parseSource("codeberg:o/r"));
      assert.match(JSON.stringify(stub.calls[0]?.headers ?? {}), /cb-token-value/);
    } finally {
      stub.restore();
    }
  } finally {
    if (prev === undefined) delete process.env.CODEBERG_TOKEN;
    else process.env.CODEBERG_TOKEN = prev;
  }
});

test("a host is recognised as a forge by its name, not by containing one", async () => {
  const { sourceFromUrls } = await import("../src/sources.ts");
  // The door in front of the token check: these URLs arrive from a brew
  // formula's homepage and from an OCI image.source label, so accepting a
  // lookalike host is how one gets into tools.json in the first place.
  assert.equal(sourceFromUrls(["https://codeberg.org.evil.tld/a/b.git"]), null);
  assert.equal(sourceFromUrls(["https://notgitea.evil.tld/a/b.git"]), null);
  assert.equal(sourceFromUrls(["https://gitea.com.evil.tld/a/b.git"]), null);
  // The hosts it is actually for still resolve.
  assert.equal(sourceFromUrls(["https://codeberg.org/o/r.git"]), "codeberg:o/r");
  assert.equal(sourceFromUrls(["https://gitea.com/gitea/tea.git"]), "https://gitea.com/gitea/tea");
  assert.equal(sourceFromUrls(["https://git.example.com/o/r.git"]), "https://git.example.com/o/r");
  // A self-hosted instance named after the software it runs is the case the
  // loose test existed for, and it has to survive the tightening.
  assert.equal(sourceFromUrls(["https://gitea.example.com/o/r.git"]), "https://gitea.example.com/o/r");
  assert.equal(sourceFromUrls(["https://forgejo.example.com/o/r.git"]), "https://forgejo.example.com/o/r");
  assert.equal(
    sourceFromUrls(["https://codeberg.org/o/r/archive/v1.tar.gz"]),
    "codeberg:o/r",
    "the shorthand path still wins before the host test is reached",
  );
});

test("each forge shape gets its own paging parameter", async () => {
  const stub = stubFetch([]);
  try {
    await listReleases(parseSource("github:o/r"), { limit: 7 });
    await listReleases(parseSource("codeberg:o/r"), { limit: 7 });
    assert.match(stub.calls[0]?.url ?? "", /per_page=7/);
    assert.match(stub.calls[1]?.url ?? "", /limit=7/);
  } finally {
    stub.restore();
  }
});

test("an exhausted rate limit says so, and names the variable that lifts it", async () => {
  // GitHub answers 403 and puts the reason only in the headers; the status
  // line alone sends the reader to check a source that is spelled correctly.
  const stub = stubFetch([], 403, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "1800000000",
  });
  const prev = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const prevGh = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    await assert.rejects(listReleases(parseSource("github:o/r")), (err: Error) => {
      assert.match(err.message, /rate limit exhausted at api\.github\.com/);
      assert.match(err.message, /GITHUB_TOKEN/, "the fix belongs in the message");
      assert.match(err.message, /resets at \d\d:\d\d/);
      return true;
    });
  } finally {
    stub.restore();
    if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
    if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
  }
});

test("a transport failure names the host and the cause, not just 'fetch failed'", async () => {
  // Node's fetch buries ENOTFOUND/ECONNREFUSED in `cause`; the bare top-level
  // message confirms a failure without naming anything actionable.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(listReleases(parseSource("github:o/r")), (err: Error) => {
      assert.match(err.message, /cannot reach api\.github\.com/);
      assert.match(err.message, /ENOTFOUND/);
      return true;
    });
  } finally {
    globalThis.fetch = real;
  }
});

// ---- rolling channels ------------------------------------------------------

/** Like stubFetch, but each call consumes the next body — the truncated path
 * asks compare first and the tag's head second, and both answers matter. */
function stubFetchSeq(bodies: unknown[]): { calls: Call[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  const queue = [...bodies];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const body = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
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

const commit = (sha: string, msg: string, date = "2026-08-10T12:00:00Z") => ({
  sha,
  commit: { message: msg, committer: { date } },
});

test("a channel gap becomes one synthetic release carrying the commit log", async () => {
  const stub = stubFetch({
    status: "ahead",
    ahead_by: 2,
    total_commits: 2,
    html_url: "https://github.com/o/r/compare/aaa1112223...tip",
    commits: [
      commit("1111111aaaaaaaaa", "terminal: first change\n\nlong body"),
      commit("2222222bbbbbbbbb", "macOS: second change"),
    ],
  });
  try {
    const ch = await channelStatus(parseSource("github:o/r"), "tip", "aaa1112223");
    assert.match(stub.calls[0]?.url ?? "", /\/repos\/o\/r\/compare\/aaa1112223\.\.\.tip\?per_page=250$/);
    assert.equal(ch.aheadBy, 2);
    assert.equal(ch.truncated, false);
    assert.equal(ch.head, "2222222bb");
    // Oldest first, one line per commit, bodies dropped — the digest reads it
    // chronologically, like the release path.
    assert.equal(ch.release?.notes, "1111111aa terminal: first change\n2222222bb macOS: second change");
    assert.equal(ch.release?.version, "2222222bb");
    assert.equal(ch.release?.tag, "tip");
    assert.equal(ch.release?.url, "https://github.com/o/r/compare/aaa1112223...tip");
    assert.equal(ch.release?.publishedAt, "2026-08-10T12:00:00Z");
  } finally {
    stub.restore();
  }
});

test("a build on the channel's head is current, not one release behind", async () => {
  const stub = stubFetch({ status: "identical", ahead_by: 0, total_commits: 0, commits: [] });
  try {
    const ch = await channelStatus(parseSource("github:o/r"), "tip", "aaa1112223");
    assert.equal(ch.aheadBy, 0);
    assert.equal(ch.release, null);
  } finally {
    stub.restore();
  }
});

test("when the page ran out, the head comes from the tag, not from mid-gap", async () => {
  // compare returns the OLDEST slice of the gap, so its last commit is only
  // the head when everything fit. Reporting a mid-gap commit as "latest"
  // would show an update target that is itself out of date.
  const stub = stubFetchSeq([
    {
      status: "ahead",
      ahead_by: 300,
      total_commits: 300,
      commits: [commit("1111111aaaaaaaaa", "old"), commit("2222222bbbbbbbbb", "still old")],
    },
    [commit("9999999fffffffff", "the actual head")],
  ]);
  try {
    const ch = await channelStatus(parseSource("github:o/r"), "tip", "aaa1112223");
    assert.equal(ch.truncated, true);
    assert.equal(ch.aheadBy, 300);
    assert.equal(ch.head, "9999999ff");
    assert.match(stub.calls[1]?.url ?? "", /\/repos\/o\/r\/commits\?sha=tip&per_page=1$/);
  } finally {
    stub.restore();
  }
});

test("a diverged build is refused, not counted against a history it is not on", async () => {
  const stub = stubFetch({ status: "diverged", ahead_by: 4, behind_by: 2, commits: [commit("aa", "x")] });
  try {
    await assert.rejects(
      channelStatus(parseSource("github:o/r"), "tip", "aaa1112223"),
      /not on tip's history/,
    );
  } finally {
    stub.restore();
  }
});

test("a 404 from compare blames the range, not the source", async () => {
  // The release path would have 404ed first if the repo were wrong — what
  // does not exist here is one endpoint of the range.
  const stub = stubFetch([], 404);
  try {
    await assert.rejects(channelStatus(parseSource("github:o/r"), "tip", "deadbeef1"), (err: Error) => {
      assert.match(err.message, /cannot compare deadbeef1\.\.\.tip/);
      assert.match(err.message, /captures a commit hash/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("with nothing installed, a channel reports its head and pends nothing", async () => {
  const stub = stubFetch([commit("9999999fffffffff", "head")]);
  try {
    const ch = await channelStatus(parseSource("github:o/r"), "tip", null);
    assert.equal(ch.head, "9999999ff");
    assert.equal(ch.release, null);
    assert.equal(ch.aheadBy, 0);
    assert.match(stub.calls[0]?.url ?? "", /\/commits\?sha=tip&per_page=1$/);
  } finally {
    stub.restore();
  }
});

test("a Forgejo channel works from total_commits alone, with its own paging", async () => {
  // Forgejo/Gitea serves the same compare path but omits status and ahead_by.
  const stub = stubFetch({
    total_commits: 1,
    commits: [commit("3333333ccccccccc", "fix: something")],
  });
  try {
    const ch = await channelStatus(parseSource("https://git.example.com/team/app"), "nightly", "aaa111222");
    assert.match(stub.calls[0]?.url ?? "", /\/api\/v1\/repos\/team\/app\/compare\/aaa111222\.\.\.nightly$/);
    assert.equal(ch.aheadBy, 1);
    assert.equal(ch.release?.notes, "3333333cc fix: something");
    // No html_url in the payload — built from the forge's own root instead.
    assert.equal(ch.release?.url, "https://git.example.com/team/app/compare/aaa111222...nightly");
  } finally {
    stub.restore();
  }
});

test("a 403 that is not about the rate limit keeps its own message", async () => {
  // Not every refusal is a quota: reading "set GITHUB_TOKEN" when one is
  // already set and the repo is simply forbidden would be a wrong instruction.
  const stub = stubFetch([], 403, { "x-ratelimit-remaining": "58" });
  try {
    await assert.rejects(listReleases(parseSource("github:o/r")), (err: Error) => {
      assert.doesNotMatch(err.message, /rate limit/);
      assert.match(err.message, /403/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("a forge that never answers does not hold the run open forever", async () => {
  // getJson had no timeout and no size limit. judge.ts already uses
  // AbortSignal.timeout for the engine call, for the same reason: a socket that
  // is neither refused nor answered is the failure mode that looks like the
  // tool having hung, and there is no key to press.
  const stub = stubFetch([]);
  try {
    await listReleases(parseSource("github:o/r"));
    const signal = stub.calls[0]?.signal;
    assert.ok(signal, "the request has to carry an abort signal");
    assert.equal(typeof signal?.aborted, "boolean");
  } finally {
    stub.restore();
  }
});
