// SPDX-License-Identifier: GPL-3.0-or-later
// The inbox against a stubbed GitHub: what becomes an entry, what stays a
// count, and which threads --mark-read is allowed to touch.
//
// GITHUB_TOKEN is pinned for the whole file. sources.ts falls back to asking
// `gh` when no env var carries a token, and these tests must not depend on —
// or read — whatever the machine running them is logged in as.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { buildInbox, markThreadsRead, shownThreads } from "../src/inbox.ts";
import type { Engine } from "../src/judge.ts";
import { renderInbox } from "../src/render.ts";
import type { Config, ToolConfig } from "../src/types.ts";

// Set before any request is made — tokens are read at call time, not import
// time, so a plain assignment here covers every test below.
const realToken = process.env.GITHUB_TOKEN;
process.env.GITHUB_TOKEN = "test-token";

after(() => {
  if (realToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = realToken;
});

const NONE: Engine = { kind: "none", model: "", label: "none (no engine reachable)" };

const config = (tools: ToolConfig[] = []): Config => ({ usagePaths: [], tools });

const tool = (name: string, source: string): ToolConfig => ({
  name,
  source,
  version: { cmd: [name, "--version"], match: "([0-9][0-9.]*)" },
  update: `# complete this: update ${name}`,
});

interface Call {
  url: string;
  method: string;
}

/**
 * Replace global fetch with a router: each URL is answered by the handler,
 * and every request is recorded with its method — mark-read is a PATCH, and
 * asserting on the method is what proves it never became the whole-inbox PUT.
 */
function stubFetch(handler: (url: string) => { status?: number; body?: unknown }): {
  calls: Call[];
  restore: () => void;
} {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const { status = 200, body = null } = handler(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "stub",
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

const notification = (
  id: string,
  repo: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  repository: { full_name: repo },
  subject: { type: "Release", url: `https://api.github.com/repos/${repo}/releases/${id}`, title: id },
  ...over,
});

const releaseBody = (tag: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: tag,
  body: `notes for ${tag}`,
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  published_at: `2026-0${tag.replace(/\D/g, "").slice(0, 1) || "1"}-01T00:00:00Z`,
  prerelease: false,
  ...over,
});

test("only release notifications become entries; the rest is counted, not expanded", async () => {
  const stub = stubFetch((url) => {
    if (url.includes("/notifications"))
      return {
        body: [
          notification("1", "o/r"),
          { id: "2", repository: { full_name: "o/r" }, subject: { type: "Issue", url: "x" } },
          { id: "3", repository: { full_name: "o/other" }, subject: { type: "PullRequest", url: "y" } },
        ],
      };
    return { body: releaseBody("v1.0.0") };
  });
  try {
    const inbox = await buildInbox(config(), { engine: NONE, concurrency: 2 });
    assert.equal(inbox.entries.length, 1);
    assert.equal(inbox.entries[0]?.repo, "o/r");
    assert.deepEqual(inbox.other, { Issue: 1, PullRequest: 1 });
    assert.equal(inbox.capped, false);
  } finally {
    stub.restore();
  }
});

test("several releases of one repo are one entry, oldest first", async () => {
  // Three claude-code releases are one report the way a tool three releases
  // behind is — one digest over all of them, in the order the digest reads.
  const stub = stubFetch((url) => {
    if (url.includes("/notifications"))
      return { body: [notification("1", "o/r"), notification("2", "o/r"), notification("3", "o/r")] };
    const id = url.split("/").at(-1);
    return {
      body: releaseBody(`v${id}.0.0`, { published_at: `2026-01-0${id}T00:00:00Z` }),
    };
  });
  try {
    const inbox = await buildInbox(config(), { engine: NONE, concurrency: 2 });
    assert.equal(inbox.entries.length, 1);
    assert.deepEqual(
      inbox.entries[0]?.releases.map((r) => r.version),
      ["1.0.0", "2.0.0", "3.0.0"],
    );
    assert.deepEqual(inbox.entries[0]?.threads, ["1", "2", "3"]);
  } finally {
    stub.restore();
  }
});

test("a prerelease is shown and flagged, not filtered", async () => {
  // listReleases drops prereleases because brew will never hand you one. Here
  // the subscription itself is the user asking for them — a machine on oMLX's
  // nightly channel gets its release news from exactly these notifications.
  const stub = stubFetch((url) => {
    if (url.includes("/notifications")) return { body: [notification("1", "o/nightly")] };
    return { body: releaseBody("v0.5.8.dev2", { prerelease: true }) };
  });
  try {
    const inbox = await buildInbox(config(), { engine: NONE, concurrency: 2 });
    assert.equal(inbox.entries.length, 1);
    assert.equal(inbox.entries[0]?.prerelease, true);
    assert.equal(inbox.entries[0]?.releases[0]?.version, "0.5.8.dev2");
  } finally {
    stub.restore();
  }
});

test("a tracked repo greps under its entry's name, an untracked one under the repo's short name", async () => {
  // anthropics/claude-code is called `claude` in scripts; searching the notes
  // under "claude-code" would miss every span the entry exists to find.
  const stub = stubFetch((url) => {
    if (url.includes("/notifications"))
      return {
        body: [notification("1", "anthropics/claude-code"), notification("2", "zen-browser/desktop")],
      };
    return { body: releaseBody("v1.0.0") };
  });
  try {
    const inbox = await buildInbox(config([tool("claude", "github:anthropics/claude-code")]), {
      engine: NONE,
      concurrency: 2,
    });
    const byRepo = new Map(inbox.entries.map((e) => [e.repo, e]));
    assert.equal(byRepo.get("anthropics/claude-code")?.tool, "claude");
    assert.equal(byRepo.get("anthropics/claude-code")?.tracked, true);
    assert.equal(byRepo.get("zen-browser/desktop")?.tool, "desktop");
    assert.equal(byRepo.get("zen-browser/desktop")?.tracked, false);
  } finally {
    stub.restore();
  }
});

test("a 401 names both ways to supply a token", async () => {
  // /notifications has no anonymous form at all, so this is the whole command
  // refusing — the message has to carry the fix, not just the status.
  const stub = stubFetch(() => ({ status: 401, body: {} }));
  try {
    await assert.rejects(buildInbox(config(), { engine: NONE, concurrency: 2 }), (err: Error) => {
      assert.match(err.message, /gh auth login/);
      assert.match(err.message, /GITHUB_TOKEN/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test("mark-read PATCHes exactly the given threads, never the whole inbox", async () => {
  const stub = stubFetch(() => ({ status: 205 }));
  try {
    const failures = await markThreadsRead(["11", "22"]);
    assert.deepEqual(failures, []);
    assert.deepEqual(stub.calls.map((c) => `${c.method} ${c.url}`).sort(), [
      "PATCH https://api.github.com/notifications/threads/11",
      "PATCH https://api.github.com/notifications/threads/22",
    ]);
  } finally {
    stub.restore();
  }
});

test("an errored entry keeps its threads out of mark-read", async () => {
  // Its releases were never shown, so the notification is the only reminder
  // the release exists — marking it read would delete that reminder.
  const entry = (threads: string[], error?: string) => ({
    repo: "o/r",
    tool: "r",
    tracked: false,
    releases: [],
    prerelease: false,
    threads,
    items: [],
    hits: [],
    mechanical: false,
    error,
  });
  assert.deepEqual(shownThreads([entry(["1", "2"]), entry(["3"], "boom")]), ["1", "2"]);
});

test("a refused thread is reported, not thrown, and does not stop the rest", async () => {
  const stub = stubFetch((url) => (url.endsWith("/11") ? { status: 403 } : { status: 205 }));
  try {
    const failures = await markThreadsRead(["11", "22"]);
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /thread 11: HTTP 403/);
    assert.equal(stub.calls.length, 2, "the refused thread must not abort the other");
  } finally {
    stub.restore();
  }
});

test("a full page is reported as capped", async () => {
  const page = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    repository: { full_name: "o/r" },
    subject: { type: "Issue", url: "x" },
  }));
  const stub = stubFetch(() => ({ body: page }));
  try {
    const inbox = await buildInbox(config(), { engine: NONE, concurrency: 2 });
    assert.equal(inbox.capped, true);
    assert.equal(inbox.entries.length, 0);
  } finally {
    stub.restore();
  }
});

test("renderInbox: an empty usagePaths config is called out", () => {
  const out = renderInbox({
    entries: [],
    other: {},
    capped: false,
    missingUsagePaths: [],
    noUsagePaths: true,
    engine: { kind: "none", model: "", label: "none" },
  });
  assert.match(out, /no usagePaths configured/);
});

test("renderInbox: empty inbox says so, and the rest of the queue stays a count", () => {
  const out = renderInbox({
    entries: [],
    other: { Issue: 2, PullRequest: 1 },
    capped: false,
    missingUsagePaths: [],
    noUsagePaths: false,
    engine: NONE,
  });
  assert.match(out, /no unread release notifications/);
  assert.match(out, /3 other unread notifications/);
  assert.match(out, /2 Issue/);
  assert.match(out, /github\.com\/notifications/);
});

test("a release whose notes cannot be read stays an entry, and keeps the exit code honest", async () => {
  // The same invariant the digest got wrong: a failure must not shrink the
  // report to nothing, because cli.ts turns `entries.length === 0` into exit
  // 0 — the code a scheduler reads as "your inbox is clear". An entry that
  // errored is still an unread release notification.
  const s = stubFetch((url) => {
    if (url.includes("/notifications")) return { body: [notification("1", "cli/cli")] };
    return { status: 500, body: { message: "upstream is having a day" } };
  });
  try {
    const inbox = await buildInbox(config([tool("gh", "github:cli/cli")]), {
      engine: NONE,
      concurrency: 1,
    });
    assert.equal(inbox.entries.length, 1, "the notification was real — losing it empties the inbox");
    assert.ok(inbox.entries[0]?.error, "and the entry has to say why it is empty");
    assert.equal(inbox.entries[0]?.releases.length, 0, "nothing was read, so nothing is claimed");
  } finally {
    s.restore();
  }
});
