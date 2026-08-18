# AGENTS.md

Working instructions for coding agents. Human contributors want
[CONTRIBUTING.md](CONTRIBUTING.md), which this condenses.

## Commands

```console
pnpm check     # tsc --noEmit — must pass
pnpm lint      # biome check — must pass
pnpm test      # node:test — must pass
pnpm format    # biome check --write
```

pnpm only; npm is blocked by a `preinstall` guard. Node 24+. No build step —
`bin/bumpii` runs `src/cli.ts` directly.

## Module map

`cli.ts` orchestration and exit codes · `config.ts` the tools.json file ·
`sources.ts` forge APIs · `version.ts` probing and comparison · `judge.ts`
engine, digest and its cache · `usage.ts` grep verdict · `render.ts` the report ·
`discover.ts` brew → config entry · `exec.ts` the execFile wrapper ·
`progress.ts` the stderr progress line · `quips.ts` what that line may say ·
`types.ts` shared shapes, read first.

## The rule

**Never state a conclusion the code did not reach.** When a check could not
be performed, give it its own state — do not fold it into the reassuring
answer. A green "up to date" for a repo that published nothing comparable is
the worst output this tool can produce, and every variant of it found so far
had looked like ordinary success.

Concretely: adding a code path that can fail quietly means adding a branch in
`render.ts` that says so, and a test that asserts the reassuring string is
*absent*.

## Traps in this codebase

- `compareVersions` sends non-numeric segments into a NaN branch that answers
  "not newer" — which is indistinguishable from being current. Filter with
  `isComparable` before ordering anything.
- `installedVersion` runs `version.match` over the binary's **whole** output,
  not the matching line. Patterns need a line anchor.
- grep exits 1 for "no matches" and 2 for a real failure. Treating them alike
  is how a missing directory became a confident "affects you: none".
- `execFile` promisified drops stdout on error; `exec.ts` reattaches it,
  because a non-zero exit often still printed the version.
- Tests must not touch the network. Stub `fetch`.
- A `biome-ignore` comment only suppresses when it fits on one line.
- An ESC byte inside a **regex literal** is a lint error (it is fine in a
  plain string), so tests that assert on escape sequences build them from a
  named `ESC` constant instead.
- The progress line is subject to the rule above like everything else: a quip
  in `quips.ts` may only name a quantity the run measured, and its predicate
  is what enforces that. Watch for the shape a digit check misses — a loose
  predicate renders `undefined releases behind`, which has no digits and is
  still a lie. Constants it quotes are imported (`PROBE_TIMEOUT_MS`) or handed
  in (`concurrency`), never retyped.
- Anything drawn to stderr must stay inside `process.stderr.columns`, and a
  reported width of `0` means unknown, not zero — `|| 80`, never `?? 80`. A
  wrapped line survives `\r\x1b[K` and every frame ends up in the scrollback.
- Killing this process does not kill what it spawned. `exec.ts` tracks every
  live child so `killChildren()` can take them along — from the signal
  handler, and from `main`'s `finally`, because a probe and its forge fetch
  share a `Promise.all` and a failing fetch exits the run while the probe is
  still going. Measured: SIGINT left a `sleep` child running and reparented.
- Registering any SIGINT listener switches off Node's default termination, so
  every path through that handler must end in `process.exit` — otherwise
  Ctrl-C does nothing at all. `once`, so a second Ctrl-C gets the default back.
  Exit codes are 128+signal (130, 143); a shell reports those and scripts read
  them.
- Node's stdout is synchronous on a file but **asynchronous on a pipe**, and
  `process.exit` drops whatever is still queued — so every exit path goes
  through `exitAfterFlush`. Before it did, a `--json` report longer than the
  64 KiB pipe buffer reached its reader cut off mid-string (93646 bytes to a
  file, exactly 65536 through a pipe) under an exit code that said the run had
  succeeded. Short reports fit in the buffer, which is why only the long ones
  ever showed it.
- Send children **SIGTERM**, whatever signal arrived. A non-interactive
  `sh -c` defers SIGINT until its current foreground command finishes, so
  passing SIGINT through let a probe run to completion and write its output
  after the run had been cancelled.
- `mock.timers.tick(5000)` runs only the timers that were already scheduled
  when it was called, so it advances a chain of `setTimeout`s by exactly one
  frame. The progress line is such a chain (each frame states its own
  duration). Use the `advance()` helper in `test/progress.test.ts`, or the
  assertions after it measure a single frame while reading as if they covered
  five seconds.
- `digest` answers from `~/.cache/bumpii/digests/` before it calls anything, so
  a test that does not point `XDG_CACHE_HOME` at a scratch directory reads
  whatever the last real run left behind. The key hashes the engine, the model
  and the **whole prompt**, which is why there is no schema version to bump:
  editing `prompt` retires exactly the entries it invalidates. Store the raw
  text rather than parsed items — a later fix to `parseItems` then reaches what
  is already cached — and store it only *after* it parses, or an unusable
  answer is pinned for every future run.
- Releases whose body is empty never reach the engine. htop tags every version
  and writes no notes, so its entire prompt was the line `### htop 3.5.3`; the
  model asked for the notes in prose, that did not parse, and the report said
  "digest failed" about an engine that had done the only thing it could. Empty
  bodies are dropped before the prompt is built, and `render.ts` names that
  case rather than folding it into the engine-failure branch.

## Definition of done

1. `pnpm check && pnpm lint && pnpm test` all pass.
2. A new test exists that fails without the change. Verify that it does —
   revert the source hunk, watch it fail, restore.
3. Any behaviour a user sees is in the README if the README describes that
   area.
4. No new runtime dependency, no build step, no change to the contracts
   listed in CONTRIBUTING.md unless that is the point of the change and it is
   stated.
5. Claims in the PR body are checkable against the diff, one bullet per
   user-visible change.

## Reporting back

State what you verified and how, and say plainly what you did not. An
unverified claim costs more than an admitted gap.
