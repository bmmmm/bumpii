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
engine and digest · `usage.ts` grep verdict · `render.ts` the report ·
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
- `mock.timers.tick(5000)` runs only the timers that were already scheduled
  when it was called, so it advances a chain of `setTimeout`s by exactly one
  frame. The progress line is such a chain (each frame states its own
  duration). Use the `advance()` helper in `test/progress.test.ts`, or the
  assertions after it measure a single frame while reading as if they covered
  five seconds.

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
