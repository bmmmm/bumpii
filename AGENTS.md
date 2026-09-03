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

**Without a TTY** — which is every agent session — those four die before they
run anything: pnpm wants to confirm a `node_modules` purge and aborts with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Call the binaries directly
instead, and note that the test runner takes no path argument (`node --test
test/` looks for a *module* called `test` and fails with MODULE_NOT_FOUND):

```console
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome check          # --write to format
node --test
```

**A green run with skips is not a green run.** Seventeen tests stand up a
loopback HTTP server as a stub forge, and a sandbox that cannot bind a port
skips them — the summary then reads `fail 0` with every forge integration path
unchecked. Read the `skipped` line, not just `fail 0`. Whether they can bind
varies between runs of the same suite in the same session, so a run reporting
`skipped 0` is the one to trust and neither is a reason to suspect the code.

## Module map

`cli.ts` orchestration and exit codes · `config.ts` the tools.json file ·
`sources.ts` forge APIs · `version.ts` probing and comparison · `judge.ts`
engine, digest and its cache · `usage.ts` reference counts · `render.ts` the report ·
`discover.ts` brew → config entry · `images.ts` container → config entry ·
`inbox.ts` the release notifications GitHub already queued ·
`outdated.ts` what brew knows is pending, and its source cache ·
`overview.ts` the whole machine, bucketed by what can be said about it ·
`limit.ts` the four-line concurrency cap · `exec.ts` the execFile wrapper ·
`progress.ts` the stderr progress line · `quips.ts` what that line may say ·
`types.ts` shared shapes, read first.

`scripts/` is not part of the tool: `progress-demo.ts` plays the real progress
line without a forge or a model, and `setup-labels.sh` creates the labels the
issue forms name — run it after adding or changing a form, because GitHub
drops a requested label that does not exist without saying so.

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

- `compareVersions` splits the core on `.` and treats `-` as the start of a
  prerelease tail, and the two are opposite answers: a letter riding on a
  segment continues the sequence (tmux tags `3.5a` after `3.5`, openssl went
  `1.1.1t` → `1.1.1w`), a word after a dash precedes it (`1.0.0-rc1` before
  `1.0.0`). One shared `/[.-]/` split erased that difference and answered
  "equal" for the first pair — which renders as a green "up to date" over a
  pending security release. Assert both cases together or the next rewrite
  fixes one by breaking the other. A tag that is not orderable at all
  (`nightly`, `latest`) is still filtered with `isComparable` before ordering.
- `installedVersion` runs `version.match` over the binary's **whole** output,
  not the matching line. Patterns need a line anchor — `^` works, `$` does not,
  because stderr is appended after stdout and there is no `m` flag. A pattern
  that captures the wrong number outranks every release and pins the entry at
  "ahead of", which `render.ts` names rather than painting green.
- grep exits 1 for "no matches" and 2 for a real failure. Treating them alike
  is how a missing directory became a confident zero — and a zero here is not
  cosmetic: `refs === 0` is what puts a package under `no signal` and keeps it
  away from the forge and the engine entirely. `resolveUsagePaths` catches the
  path that is already gone; every other exit 2 — a directory this user may not
  read, one that disappeared mid-run, a walk killed on its timeout — comes back
  from the wrappers in `usage.ts` as `incomplete`, and the report says so above
  the tally. Whatever matches did arrive are kept: incomplete is a floor, not a
  wipe.
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
- How many items a digest produces is not stable across runs, and nothing in
  the code decides it. Measured: five cold runs of the same 18.7k of notes
  through `claude-cli/haiku` returned 27/28/29/30/31 items — ±2 around the mean,
  every run reading the same text. Two other packages came back 30/30/31 and
  49/52/52. So do not read a changed count as a regression, and do not pin an
  exact one in a test against a live engine. The same notes judged twice are one
  answer only because the digest cache makes them one; a cache miss re-rolls it.
  The OpenAI path already sends `temperature: 0`, and the `claude` CLI has no
  equivalent to set. An overview entry shows ten items whatever the count is,
  which is what keeps this out of the report.
- Releases whose body is empty never reach the engine. htop tags every version
  and writes no notes, so its entire prompt was the line `### htop 3.5.3`; the
  model asked for the notes in prose, that did not parse, and the report said
  "digest failed" about an engine that had done the only thing it could. Empty
  bodies are dropped before the prompt is built, and `render.ts` names that
  case rather than folding it into the engine-failure branch — in all three
  reports, through the one `noDigestReason`. It was fixed in `overview.ts`
  first and the digest and inbox paths kept the old wording for a while, with a
  test pinning it, so a shared function is what keeps them from drifting again.
- The `claude` CLI is invoked as `-p <prompt> --model M --allowedTools ""`, and
  the flag order is load-bearing: `--allowedTools` takes a variadic
  `<tools...>`, so a prompt placed after it is read as a tool name and the call
  dies with "Input must be provided either through stdin or as a prompt
  argument". Measured both ways.
- The renderers strip control bytes from everything of forge or model origin,
  at the point the data enters them (`safeReport`/`safeEntry` in `render.ts`)
  rather than at each interpolation — there are about thirty, and the one that
  gets forgotten is the hole. `stripAnsi` in `exec.ts` is a different job:
  cleaning a local binary's output before a regex reads a version out of it,
  and it only handles SGR, which cannot move a cursor.
- `Math.sign(0)` is `0` and `-Math.sign(0)` is `-0`, which `assert.equal`
  tells apart. An antisymmetry check has to sum the two signs, not negate one.
- Read env vars that name a path with `||`, never `??`: an exported-but-empty
  `XDG_CONFIG_HOME` is not a value, and `??` only falls back on undefined —
  which put `tools.json` in whatever directory the command ran from.

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
