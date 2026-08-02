// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { limiter } from "../src/limit.ts";

test("limiter never exceeds max concurrent calls", async () => {
  const run = limiter(2);
  let active = 0;
  let peak = 0;

  const job = () =>
    run(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return active;
    });

  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2, "never more than `max` jobs should run at once");
});

test("limiter still resolves every call with its own result", async () => {
  const run = limiter(2);
  const results = await Promise.all([1, 2, 3].map((n) => run(async () => n * 10)));
  assert.deepEqual(results, [10, 20, 30]);
});

test("limiter propagates a rejection without blocking the ones behind it", async () => {
  const run = limiter(1);
  const first = run(async () => {
    throw new Error("boom");
  });
  const second = run(async () => "ok");
  await assert.rejects(first, /boom/);
  assert.equal(await second, "ok");
});
