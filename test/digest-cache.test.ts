// SPDX-License-Identifier: GPL-3.0-or-later
// The digest cache, which is what stands between a second `overview` and a
// second round of one LLM call per tool. Its whole claim is that a hit is the
// same answer rather than a stale one, so the tests are about what goes into
// the key as much as about whether the file is found.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  digest,
  digestCacheDir,
  digestKey,
  type Engine,
  readCachedDigest,
  writeCachedDigest,
} from "../src/judge.ts";
import type { Release } from "../src/types.ts";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "bumpii-digest-"));
  dirs.push(d);
  return d;
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const OPENAI: Engine = { kind: "openai", model: "qwen3-30b", label: "test" };

function release(version: string, notes: string): Release {
  return {
    tag: `v${version}`,
    version,
    publishedAt: "2026-08-01T00:00:00Z",
    notes,
    url: `https://example.invalid/releases/v${version}`,
  };
}

const ANSWER =
  '[{"kind":"fix","summary":"Handle empty input","commands":["tool run --strict"],"version":"1.2.0"}]';

/**
 * Point the engine and the cache at test-local state, and count the calls that
 * reach the model — the number this whole feature exists to hold down.
 */
function withEngine(reply: () => string | Error): {
  calls: number;
  restore: () => void;
  dir: Promise<string>;
} {
  const realFetch = globalThis.fetch;
  const prevBase = process.env.OPENAI_BASE_URL;
  const prevCache = process.env.XDG_CACHE_HOME;
  const state = { calls: 0 };
  process.env.OPENAI_BASE_URL = "http://engine.invalid/v1";
  const dir = scratch().then((d) => {
    process.env.XDG_CACHE_HOME = d;
    return d;
  });
  globalThis.fetch = (async () => {
    state.calls += 1;
    const body = reply();
    if (body instanceof Error) throw body;
    return {
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => ({ choices: [{ message: { content: body } }] }),
      text: async () => "",
    };
  }) as unknown as typeof globalThis.fetch;
  return {
    get calls() {
      return state.calls;
    },
    dir,
    restore: () => {
      globalThis.fetch = realFetch;
      if (prevBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevBase;
      if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevCache;
    },
  };
}

test("the same notes judged twice reach the model once", async () => {
  const env = withEngine(() => ANSWER);
  try {
    await env.dir;
    const releases = [release("1.2.0", "Fixed `tool run --strict` on empty input")];
    const first = await digest(OPENAI, "tool", releases);
    const second = await digest(OPENAI, "tool", releases);
    assert.deepEqual(second, first);
    assert.equal(first.length, 1);
    // The point of the whole feature: the second run pays a file read, not a
    // model call.
    assert.equal(env.calls, 1);
  } finally {
    env.restore();
  }
});

test("a different model is a different question, so it is asked again", async () => {
  const env = withEngine(() => ANSWER);
  try {
    await env.dir;
    const releases = [release("1.2.0", "Fixed `tool run --strict` on empty input")];
    await digest(OPENAI, "tool", releases);
    // Switching engines must produce that engine's reading rather than replay
    // the other one's under its name.
    await digest({ ...OPENAI, model: "haiku" }, "tool", releases);
    assert.equal(env.calls, 2);
  } finally {
    env.restore();
  }
});

test("different notes under the same version are judged again", async () => {
  const env = withEngine(() => ANSWER);
  try {
    await env.dir;
    await digest(OPENAI, "tool", [release("1.2.0", "first wording")]);
    // Keyed on the notes, not on (tool, version): a forge that edits a release
    // body must not be answered from the text it replaced.
    await digest(OPENAI, "tool", [release("1.2.0", "edited wording")]);
    assert.equal(env.calls, 2);
  } finally {
    env.restore();
  }
});

test("an answer the parser rejects is never stored", async () => {
  const env = withEngine(() => "I think the release looks fine, honestly.");
  try {
    const dir = await env.dir;
    const releases = [release("1.2.0", "some notes")];
    await assert.rejects(() => digest(OPENAI, "tool", releases));
    // Asserted on the directory rather than on a key built here: a key built
    // from the wrong prompt is absent no matter what the code did, which is a
    // test that passes while the bytes it names sit on disk.
    const { readdir } = await import("node:fs/promises");
    const left = await readdir(join(dir, "bumpii", "digests")).catch(() => [] as string[]);
    assert.deepEqual(left, [], "an unparseable answer must leave nothing behind");
    // And the run after a bad answer still has to be able to get a good one.
    await assert.rejects(() => digest(OPENAI, "tool", releases));
    assert.equal(env.calls, 2);
  } finally {
    env.restore();
  }
});

test("a stored answer that no longer parses is a miss, not a failed run", async () => {
  const env = withEngine(() => ANSWER);
  try {
    const dir = await env.dir;
    const releases = [release("1.2.0", "some notes")];
    await digest(OPENAI, "tool", releases);
    assert.equal(env.calls, 1);

    // Overwrite the stored text with something a tightened parser would refuse.
    const cacheDir = join(dir, "bumpii", "digests");
    const { readdir } = await import("node:fs/promises");
    const [file] = await readdir(cacheDir);
    assert.ok(file, "the first digest should have written a file");
    await writeFile(join(cacheDir, file), "not an array at all", "utf8");

    const items = await digest(OPENAI, "tool", releases);
    assert.equal(items.length, 1);
    assert.equal(env.calls, 2);
  } finally {
    env.restore();
  }
});

test("an engine that judges nothing is never consulted or cached", async () => {
  const env = withEngine(() => ANSWER);
  try {
    await env.dir;
    assert.deepEqual(
      await digest({ kind: "none", model: "", label: "none" }, "tool", [release("1.0.0", "x")]),
      [],
    );
    // No releases means nothing to judge, whatever the engine is.
    assert.deepEqual(await digest(OPENAI, "tool", []), []);
    assert.equal(env.calls, 0);
  } finally {
    env.restore();
  }
});

test("the key covers the engine kind, not only the model name", async () => {
  // Two engines can serve the same model name and answer differently; the CLI
  // and a local server on "haiku" are not interchangeable.
  const cli = digestKey({ kind: "claude-cli", model: "haiku", label: "" }, "same prompt");
  const openai = digestKey({ kind: "openai", model: "haiku", label: "" }, "same prompt");
  assert.notEqual(cli, openai);
});

test("a missing or unreadable entry reads as absent", async () => {
  const dir = await scratch();
  assert.equal(await readCachedDigest("deadbeef", dir), null);
  assert.equal(await readCachedDigest("deadbeef", join(dir, "nope")), null);
});

test("writing to an unwritable directory costs the cache, not the run", async () => {
  // The write path is best-effort by design: a read-only cache dir must not
  // turn a working digest into a failed one.
  await writeCachedDigest("k", "value", "/dev/null/not-a-dir");
});

test("a round trip returns the bytes that were stored", async () => {
  const dir = await scratch();
  const key = digestKey(OPENAI, "prompt text");
  await writeCachedDigest(key, ANSWER, dir);
  assert.equal(await readCachedDigest(key, dir), ANSWER);
  // Published by rename, so no temp file is left behind for the next reader.
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(dir), [`${key}.txt`]);
});

test("the cache directory follows XDG_CACHE_HOME", async () => {
  const prev = process.env.XDG_CACHE_HOME;
  try {
    process.env.XDG_CACHE_HOME = "/tmp/xdg-probe";
    assert.equal(digestCacheDir(), join("/tmp/xdg-probe", "bumpii", "digests"));
    delete process.env.XDG_CACHE_HOME;
    assert.match(digestCacheDir(), /\.cache\/bumpii\/digests$/);
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  }
});

test("stored text survives a reparse into the same items", async () => {
  const dir = await scratch();
  const key = digestKey(OPENAI, "p");
  await writeCachedDigest(key, ANSWER, dir);
  const raw = await readCachedDigest(key, dir);
  assert.ok(raw);
  assert.equal(JSON.parse(raw)[0].summary, "Handle empty input");
  assert.equal(await readFile(join(dir, `${key}.txt`), "utf8"), ANSWER);
});
