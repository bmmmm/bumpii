#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Plays the real progress line through a plausible run, so it can be looked at
// without waiting on a forge or a model.
//
//   node scripts/progress-demo.ts
//
// It imports src/progress.ts rather than reimplementing it: a demo that drifts
// from the thing it demonstrates is worse than no demo.
import { startProgress } from "../src/progress.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

if (!process.stderr.isTTY) {
  // Being silent here is the feature, but a demo that only says so leaves you
  // with no way to see the thing it demonstrates.
  process.stderr.write(
    "stderr is not a terminal, so the progress line stays silent — which is exactly what\n" +
      "keeps pipes, --json and cron clean. To watch it, run this from a terminal directly:\n\n" +
      "  node scripts/progress-demo.ts\n\n" +
      "(a redirect, a pipe, or an editor's output pane all count as 'not a terminal')\n",
  );
  process.exit(0);
}

const p = startProgress();

// The shape of a real `bumpii overview` on a machine with a dozen pending
// packages and a local model doing the reading.
p.phase("brew");
await sleep(2500);

p.phase("engine");
p.set({ engine: "openai" });
await sleep(2000);

p.phase("grep", { commands: 46, roots: 3 });
await sleep(1500);

p.phase("fetch", { total: 12, done: 0, tools: 12 });
for (let i = 0; i < 12; i++) {
  p.set({ releases: (i + 1) * 3 });
  p.step();
  await sleep(350);
}

p.phase("judge", { total: 12, done: 4, tools: 12, concurrency: 3 });
for (let i = 0; i < 8; i++) {
  p.step();
  await sleep(1200);
}

p.phase("grep", { commands: 46, roots: 3 });
await sleep(1500);

p.out("\n  …and here the report would print, with the line already gone.\n\n");
p.stop();
