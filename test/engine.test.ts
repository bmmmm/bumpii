// SPDX-License-Identifier: GPL-3.0-or-later
// Engine selection, which decides whether release notes leave the machine and
// whether anything gets judged at all — so it has to be honest about what it
// found, including when it found nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveEngine } from "../src/judge.ts";

interface Env {
  restore: () => void;
  calls: string[];
}

/** Point OPENAI_BASE_URL at a stubbed server; `serve` shapes its /models reply. */
function withServer(serve: () => unknown): Env {
  const realFetch = globalThis.fetch;
  const prevBase = process.env.OPENAI_BASE_URL;
  const calls: string[] = [];
  process.env.OPENAI_BASE_URL = "http://engine.invalid/v1";
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    const body = serve();
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
      if (prevBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevBase;
    },
  };
}

test("the local server is preferred and its own model list is used", async () => {
  // No model is hardcoded or crowned: /v1/models is asked what it serves.
  const env = withServer(() => ({ data: [{ id: "qwen3-30b" }, { id: "other" }] }));
  try {
    const engine = await resolveEngine();
    assert.equal(engine.kind, "openai");
    assert.equal(engine.model, "qwen3-30b");
    assert.match(env.calls[0] ?? "", /\/v1\/models$/);
  } finally {
    env.restore();
  }
});

test("an unreachable OPENAI_BASE_URL is probed even when --model names one", async () => {
  // Skipping the probe reported a dead server as the engine, and every tool
  // then made its own doomed request — one failure printed per tool.
  const env = withServer(() => new Error("connect ECONNREFUSED"));
  try {
    const engine = await resolveEngine({ model: "some-model" });
    assert.equal(env.calls.length, 1, "the server has to be probed before it is announced");
    assert.notEqual(engine.kind, "openai", "a dead server must not be reported as the engine");
    assert.match(engine.label, /OPENAI_BASE_URL unreachable/, "the footer has to say why");
    assert.match(engine.label, /ECONNREFUSED/, "and what the failure was");
  } finally {
    env.restore();
  }
});

test("the reason names the transport failure, not just that there was one", async () => {
  // Node reports every one of these as a bare "fetch failed" and hides the
  // actionable part in `cause`.
  const env = withServer(() => {
    const e = new Error("fetch failed");
    e.cause = new Error("connect ECONNREFUSED 127.0.0.1:8080");
    return e;
  });
  try {
    const engine = await resolveEngine();
    assert.match(engine.label, /ECONNREFUSED 127\.0\.0\.1:8080/);
  } finally {
    env.restore();
  }
});

test("--model beats the served list, because a server may serve more than it lists", async () => {
  const env = withServer(() => ({ data: [{ id: "listed-model" }] }));
  try {
    const engine = await resolveEngine({ model: "unlisted-model" });
    assert.equal(engine.kind, "openai");
    assert.equal(engine.model, "unlisted-model");
  } finally {
    env.restore();
  }
});

test("a reachable server that lists nothing falls through and says so", async () => {
  const env = withServer(() => ({ data: [] }));
  try {
    const engine = await resolveEngine();
    assert.notEqual(engine.kind, "openai");
    assert.match(engine.label, /serves no models/);
  } finally {
    env.restore();
  }
});

test("with no OPENAI_BASE_URL the label carries no complaint about it", async () => {
  const prev = process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
  try {
    const engine = await resolveEngine();
    assert.doesNotMatch(engine.label, /OPENAI_BASE_URL/, "unset is not a failure worth reporting");
  } finally {
    if (prev !== undefined) process.env.OPENAI_BASE_URL = prev;
  }
});
