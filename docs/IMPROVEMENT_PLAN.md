# Improvement plan

Analyzed on 2026-10-05. Implementation started on 2026-10-06.

Completed: F1 (pending self-updating casks excluded from current), F7 (digest
errors take precedence over pending updates), F2 (overview notes bounded by
brew's upgrade interval), F3 (retryable source discovery failures), F5 (invalid
model items rejected before caching), F4 (model-input omissions in reports).
Open: F6.

F1 verification: 466 tests passed without skips; omitting either pending list
made the new CLI assertions fail. Live gcloud-cli remained pending at
572.0.0 → 587.0.0 and no longer appeared in `current`.

F7 verification: 468 tests passed without skips, including text and JSON
reports with one pending and one failed tool. Reversing the precedence,
ignoring errors, and ignoring a single pending release each failed an assertion.

F2 verification: 481 tests passed without skips. Real subprocess/forge/engine
stubs cover branches, preview, targets ahead of or behind the forge, revisions,
cask builds and unknown bounds; CLI text and JSON agree on the range. Mutations
independently exercise both bounds, both orderability guards, reversed bounds,
branch/channel selection, packaging suffixes, page boundaries and report states.
Use two-component packaging versions in these tests: three-component examples
alone did not detect a removed suffix normalization.

F3 verification: 488 tests passed without skips. Subprocess tests cover recovery,
mixed batches, confirmed nulls, legacy revalidation and failed persistence.
CLI text and JSON retain lookup errors with or without usage references;
explicit sources take precedence. Cache conditions and report branches were
mutated independently and failed assertions.

F5 verification: 498 tests passed without skips. Invalid objects, scalar/null
items, wrong summary types and blank summaries fail visibly; mixed arrays cannot
become partial success. Corrected answers and old malformed cache entries recover.
Each shape guard, the summary guard and cache-before-validation were mutated;
all failed assertions. Valid empty arrays and unknown kinds remain supported.

F4 verification: 506 tests passed without skips. Sent prompts and cold/cached
results agree below, at and above the budget, including shared budgets. Digest,
overview and inbox retain the qualifier in text and JSON alongside valid items.
Mutations cover the cut boundary, counts, both cache paths, each caller and the
shared renderer, including control-byte stripping in the new links.

Baseline: `fc58565c0d50a54bfc3bd1a6c3f59bc1803a5605`; local `main`,
`origin/main`, and `github/main` matched after fetching both remotes.

## Assessment

The highest-value work is making existing results trustworthy at the remaining
failure boundaries. Seven weaknesses were reproduced despite the existing
464-test suite passing. One also reproduces against this machine's live
Homebrew data. The common cause is lost information: a failure becomes an
empty result, a report combines different release ranges, or a qualifier stays
inside the model prompt instead of reaching the reader.

Keep the existing strengths: no runtime dependencies or build step, strict
TypeScript, real CLI process tests, forge stubs, and explicit report states.
A general rewrite of the CLI or a new test framework does not address these
measured failures. Extend the current modules and tests at each boundary.

## Evidence and reproduction

| Check | Observed result |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | Passed |
| `./node_modules/.bin/biome check` | Passed; one info diagnostic: schema 2.5.11, CLI 2.5.14 |
| `node --test --test-timeout=60000`, sandboxed | 464 tests: 420 passed, 44 skipped; insufficient evidence |
| Same suite with loopback allowed | Two runs: 464 passed, 0 failed, 0 skipped; 94.3 / 99.0 seconds |
| Offline regression probes below | 8 assertion failures across 7 findings, 0 skipped; about 3 seconds |
| Live `brew outdated --json=v2 --greedy-auto-updates` | 3 formulae and 5 casks pending |
| Live overview, temporary tracked `gcloud-cli` entry | Simultaneously current at 572.0.0 and pending to 587.0.0 |

The live overview used real brew subprocesses with a temporary tracking config
and an isolated derived-cache location. Its contradictory output was:

```text
tracked, up to date
  gcloud-cli 572.0.0

updates itself (1)
  gcloud-cli  572.0.0 → 587.0.0
```

Run the retained [regression probes](../scripts/analysis-2026-10-05.mjs):

```sh
node --test scripts/analysis-2026-10-05.mjs
node --test --test-name-pattern='F3:' scripts/analysis-2026-10-05.mjs
```

These are opt-in **red reproductions**, outside the default `node --test`
discovery patterns. Exit 1 is expected on the baseline: assertions describe
the desired behaviour, not the bugs. Diagnostics show the actual values.
They run production functions, renderers, real stub-brew subprocesses, and
one complete CLI process. All fetches are intercepted; models, upgrades, and
external services are not contacted. F2 has two cases, hence eight tests for
seven findings. During implementation, move each regression into its existing
test file and remove the corresponding probe when the fix is proved.

## Order and scope

P1 means incorrect status, scope, or automation result in an otherwise usable
run. P2 means loss of information under a lookup or model failure/limit.
S means a bounded change in one flow; M means result propagation across
callers, cache, or renderers. These are relative estimates, not measured hours.

| Order | ID | Priority | Size | Work unit |
| --- | --- | --- | --- | --- |
| 1 | F1 | P1 | S | Keep pending self-updating casks out of the current bucket |
| 2 | F7 | P1 | S | Make a known digest error take precedence over pending updates |
| 3 | F2 | P1 | M | Keep overview notes within the displayed brew upgrade range |
| 4 | F3 | P2 | M | Preserve failed source discovery as retryable unknown |
| 5 | F5 | P2 | M | Reject invalid model items before caching |
| 6 | F4 | P2 | M | Carry model-input omissions into reports and JSON |
| 7 | F6 | P2 | M | Distinguish failed installation lookup from confirmed absence |

Each row is a separate tested commit. F3 and F6 share a failure pattern but
own different answers; avoid making either depend on a broad cache/state
framework. F5 precedes F4 so the digest result changes build on validated items.

## Implementation units

### F1 — one cask appears as both current and behind

**Evidence:** live gcloud-cli case above and offline `selfy` case. Both
`current` and `selfUpdating` contain the package. In
[overview.ts](../src/overview.ts), `outdatedNames` near line 463 is built only
from the plain outdated list; `quiet` never excludes the greedy-only list.

**Smallest fix:** exclude known pending self-updating packages from `quiet`,
using the existing alias matching. Preserve their existing pending section
and exit-code treatment.

**Acceptance:** tracked casks, binary aliases and `--only` never produce both
states. A genuinely current formula still appears as current. Assert absence
of the reassuring line in a CLI regression, not only array membership.
Extend `test/cli.test.ts`; document the behaviour in the overview README area.

### F7 — a known fetch error is hidden behind exit 1

**Evidence:** a complete `digest --no-judge` process prints one pending release
and another tool's HTTP 503 error, then exits 1. In
[cli.ts](../src/cli.ts), the ordinary digest returns for pending releases near
line 1973 before checking `reports.some(r => r.error)`. The update path already
checks errors first. `CONTRIBUTING.md` assigns 2 to errors.

**Smallest fix:** apply error precedence to the ordinary digest too. Keep
successful per-tool results visible alongside the failure.

**Acceptance:** all-current → 0; pending-only → 1; failed-only → 2;
pending-plus-failed → 2, including `--json`. Add the mixed case to
`test/cli.test.ts`, preserving the existing exit-code contract and stating
mixed-result precedence in README. Do not broaden this change to digest-model
errors without a separate contract decision.

### F2 — overview includes releases outside its own displayed range

**Evidence:** brew says `app 1.0.0 → 1.1.0`, but `behind` contains 1.1.0 and
1.2.0. With `app@1`, it contains 1.1.0 and 2.0.0. The real build path was
entered: one file reference and one forge fetch in each case. At
[overview.ts](../src/overview.ts) line 401, `releasesBehind` applies only the
installed lower bound; `pkg.latest` is used for the heading/compare link but
not for the notes passed to the engine.

**Smallest fix:** make the overview select a package-appropriate interval
`installed < release <= brew target`. Reuse the branch/channel selection in
[notes.ts](../src/notes.ts) where applicable. Keep upstream-only updates
separate from the range brew can deliver; do not fabricate tags for revisions.

**Acceptance:** ordinary formula, `@major`/`@major.minor` formula, and the
supported preview channel get only their own applicable releases. Cover a
forge ahead of brew, a forge behind brew, `_revision` and cask `,build`
versions, and an unorderable target. If the interval cannot be established,
report that limitation. Verify actual model input, report counts and compare
links describe the same interval. Extend `test/overview.test.ts` and the
overview CLI regressions; explain the interval in README.

### F3 — a transient brew failure becomes permanent missing metadata

**Evidence:** the first `brew info` fails; `sources.json` records `app: null`.
A direct lookup after recovery correctly resolves the source, but the next
`resolveSources` call returns null without another brew call. In
[outdated.ts](../src/outdated.ts), `brewSources` returns `{}` on a singleton
failure near line 341; `resolveSources` converts missing entries to cached
null near line 378 and never refreshes them.

**Smallest fix:** retain a distinction between successful metadata with no
forge URL and metadata that could not be read. Cache the former; retry the
latter on the next run and surface its failure in the current report.
Old nulls have no provenance, so plan a bounded revalidation of legacy null
entries rather than assuming they are confirmed negatives forever.

**Acceptance:** failure → recovery resolves automatically; a mixed batch
retains successful answers while only failed names remain retryable; a
confirmed missing source still caches. Prove legacy-null recovery and cache
write failure independently. Extend `test/outdated.test.ts` and report tests;
document the repair semantics beside `sources.json` in README.

### F5 — invalid model items become a cached “no items” answer

**Evidence:** a nonempty model array with `summary: 42` yields `[]` twice;
only one engine request occurs. The renderer explains the result as either
no user-visible changes or dependency bumps. In [judge.ts](../src/judge.ts)
near line 159, invalid/empty summaries are silently dropped, and `digest`
stores the raw answer after that parse succeeds.

**Smallest fix:** validate each item's shape and surface malformed entries
as a digest error before caching. Preserve a legitimate empty array and the
existing `unclassified` handling for unknown kinds. Strict parsing on cache
read should invalidate old malformed entries through the existing retry path.

**Acceptance:** malformed objects, scalar/null entries, wrong summary types
and whitespace-only summaries cannot masquerade as a legitimate empty result.
Test mixed valid/invalid arrays, valid `[]`, unknown kinds, a corrected second
answer, and a malformed pre-existing cache entry. The renderer keeps raw
release links and names the digest failure. Extend `test/engine.test.ts`,
`test/digest-cache.test.ts` and `test/report.test.ts`; update the engine/cache
README section.

### F4 — model-input truncation is invisible in the final report

**Evidence:** 60,024 note characters include an end marker representing a
security change. The captured prompt omits the marker; the final report
shows the stub's feature summary without a truncation qualifier. In
[judge.ts](../src/judge.ts) near line 110, the 60,000-character budget is
split across releases. The truncation notice stays in the prompt.
`ToolReport.truncated` currently describes forge pagination, a different limit.

**Smallest fix:** propagate omitted-input metadata from prompt construction
through digest callers to the human report and JSON. Recompute it on cache
hits too. Initially retain the existing budget and link to full notes;
chunking or extra model calls are a later product choice, not needed to make
the limitation honest.

**Acceptance:** below/exactly at/above the cap; multiple releases sharing the
budget; cold and cached answers; digest, overview and inbox renderers.
An input omission must remain visible even when the model returns valid items.
Test the actual sent prompt and final output. Preserve the existing meaning
of pagination and the overview's display cap. Any new JSON metadata must be
additive and documented. Extend digest-cache, report, overview and inbox tests.

### F6 — a failed installed-version query is stated as absence

**Evidence:** both brew listing subprocesses fail without stdout. The overview
records `reason: "not-installed"` and says brew does not have the tool.
[outdated.ts](../src/outdated.ts) near line 182 discards the error while keeping
stdout; [overview.ts](../src/overview.ts) near line 497 interprets a missing
map entry as absence.

**Smallest fix:** keep successful partial version output and carry lookup
failures separately. Use an explicit unverified-installation state when the
listing cannot establish whether a requested package exists. Do not undo
the deliberate handling of mixed formula/cask calls returning partial output.

**Acceptance:** genuine absence after a successful lookup, formula-only,
cask-only, mixed successful/failed listings, timeout, and partial stdout.
Prove both the unknown reason and absence of the “not installed” claim for
failed reads. Extend outdated, overview and CLI tests; document the state.

## Verification for every implementation unit

1. Move its failing probe into the existing suite and show the assertion
   failure on the baseline; keep fixture populations nonempty and assert the
   intended path was reached.
2. Implement only that unit. Keep public exit codes, config compatibility,
   the no-runtime-dependency contract and unrelated working-tree changes intact.
3. Run its regressions; mutate each new condition operand independently on a
   scratch copy. Each mutation must reach the intended assertion failure,
   not fail to compile or run zero tests.
4. Run type check, lint and the full suite with zero skips. Update the
   affected README area. Validate CLI text and JSON where the unit changes
   them, including absence of misleading reassurance.
5. Commit that unit, push both remotes, and inspect the exact commit's Linux
   and macOS CI results. For F1, repeat the live-data check if an installed
   self-updating cask is still pending; otherwise state the changed conditions.

## Deferred and unverified

- The Biome schema drift is confirmed but informational. Align it with the
  installed version in a small maintenance change; no dependency upgrade is
  justified by this diagnostic alone.
- This analysis did not execute upgrades, contact a live model, benchmark
  model latency, or audit dependency advisories. No claim about those follows
  from the tests above.
- Local runtime was Node 26.10.0. Node 24/Linux coverage comes from CI, not
  from these local measurements.
- Parser rewrites, a CLI split, new features, extra release pagination and
  broad performance work have no measured requirement from this review.
  Revisit them when a concrete symptom justifies a separate work unit.

The status above tracks implementation. Remaining units stay open until their
acceptance criteria and mutation checks have passed; their opt-in probes are
removed as regressions enter the normal suite.
