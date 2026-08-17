<p align="center">
  <img src="assets/logo.gif" alt="bumpii — a capsule mascot bouncing beside the wordmark" width="560">
</p>

# bumpii

Read what actually changed in the CLI tools and containers you run — judged
against your own usage — then bump them.

Release notes are long, and most of them are not about you. `bumpii` collects
every release between the version you have installed and the newest one,
digests them into security / breaking / feature / fix, and then answers the
question the notes cannot: **do any of these touch commands I actually call?**

```console
$ bumpii digest
gh 2.92.0 → 2.96.0  4 releases behind
  ! security Authorization header incorrectly included in requests to TUF mirrors (2.93.0)
  ! security Command execution when connecting to a malicious Codespace (2.96.0)
  + feature  Read repository files without cloning (2.95.0)
      you use this: ~/.claude/skills/gh-repo-audit/SKILL.md
  · fix      Print 'gh auth refresh' suggestion for 401 responses (2.93.0)
  affects you: 3 of 26 changes touch commands you call
  → brew upgrade gh

fj 0.6.0  up to date

engine: claude-cli/haiku
```

The relevance verdict is not the model's opinion. The model extracts which CLI
surface each note talks about; `bumpii` then greps your own scripts for exactly
those strings. "affects you: none" means the commands were searched for and not
found — which is why the two security items above carry no file list: nothing
here calls `gh attestation` or `gh release verify`.

## Install

```console
$ gh repo clone bmmmm/bumpii && cd bumpii
$ ln -sf "$PWD/bin/bumpii" ~/.local/bin/bumpii
$ bumpii init          # writes ~/.config/bumpii/tools.json
```

That is the whole install. **No dependency step** — nothing outside Node's own
standard library is imported at runtime, and Node 24+ executes the TypeScript
sources directly, so there is no build either. `pnpm install` is only needed to
work on the code (typescript, `@types/node` and biome, all dev-only).

Optional, and only for what they enable: `brew` for `bumpii add`/`scan`,
`podman` or `docker` for `bumpii add --image`, `grep` for the usage verdict
(present everywhere), and an engine for the digest — see below.

## Commands

| | |
| --- | --- |
| `bumpii` | this help — the digest is asked for by name |
| `bumpii digest` | digest pending releases for everything tracked |
| `bumpii overview` | everything brew has pending, ranked by your own usage |
| `bumpii inbox` | unread GitHub release notifications, digested |
| `bumpii init` | write a starter config |
| `bumpii add <formula>…` | derive entries from installed Homebrew formulae |
| `bumpii add --image <container>…` | derive entries from running containers |
| `bumpii scan` | installed formulae not yet tracked |
| `bumpii scan --image` | running containers not yet tracked |
| `bumpii scan --new` | what was installed or upgraded recently |
| `bumpii scan --unref` | formulae no file in `usagePaths` names |
| `bumpii list` | what is tracked, and what is still incomplete |
| `bumpii set <name> <field> <value>` | change one field: `source` or `update` |
| `bumpii rm <name>…` | stop tracking these |
| `bumpii digest --yes` | digest, then run each tool's update command |
| `bumpii digest --brew-upgrade` | digest, then `brew update && brew upgrade` — everything brew has pending, tracked or not |
| `bumpii digest --yes --dry-run` | print the update commands that would run, run none |

`bumpii --help` carries the options; the sections below cover what each of
these does and why.

## The whole machine at once

`bumpii digest` reports on what you tracked. `bumpii overview` starts from what
Homebrew already knows is pending — every formula and cask, tracked or not —
and sorts it by whether it can say anything useful about it:

```console
$ bumpii overview

★ digested
├─ gh     2.96.0 → 2.97.0   4 releases   12 refs
│    https://github.com/cli/cli/compare/v2.96.0...v2.97.0
│    ! security Authorization header incorrectly included in TUF mirror requests (2.97.0)
│      you use this: ~/ops/scripts/release.sh
│    affects you: 1 of 26 changes touch commands you call
│    → brew upgrade gh
└─ docker 29.6.2 → 29.7.2   2 releases    7 refs   untracked
     https://github.com/docker/cli/compare/v29.6.2...v29.7.2
     …
     → brew upgrade docker

★ pending, not digested
└─ some-tool 1.4.0 → 1.4.1   1 release   3 refs
     digest failed: engine timed out; raw notes:
       1.4.1  https://github.com/o/some-tool/releases/tag/v1.4.1
     → brew upgrade some-tool

referenced, but bumpii found no repo to read
└─ node 26.5.0 → 26.7.0   5 refs   untracked
     no forge repo in its brew URLs — nothing to read, and bumpii will not guess one
     name it yourself: bumpii add node --source github:owner/repo

tracked, up to date
  jq 1.8.2 · fj 0.6.0 · shellcheck 0.11.0

no signal (12)
  no file in your usagePaths names these — version and link only
  fzf       0.74.1 → 0.74.2
    https://github.com/junegunn/fzf/releases
  harfbuzz  14.2.1 → 14.3.0
    https://github.com/harfbuzz/harfbuzz/releases
  …

23 pending — 2 digested · 1 not digested · 1 no repo · 12 unreferenced
8 tracked and current
  worth tracking: bumpii add docker
engine: claude-cli/haiku
```

**What decides the buckets is your own files, not a list of important
packages.** The reference count is how many files in `usagePaths` name each
one, and a package no file names never reaches the engine: with no usage to
check a release note against, a model asked anyway would return an opinion
rather than the verdict the rest of this tool is built on. Those still get a
version and a link, because that is what the data supports.

Being untracked is no reason to skip the digest — `docker` above gets the same
treatment as `gh` — so `tools.json` decides what `bumpii` watches, not what
`overview` can tell you. `worth tracking` at the end names the ones that
earned an entry.

Three states are deliberately kept out of "up to date", because each means
bumpii could not check rather than checked and found nothing. A package whose
brew URLs name no forge (node ships from nodejs.org) says so instead of having
a repo guessed for it. Tracked entries brew does not manage — containers,
anything installed by hand — are listed under `tracked, not covered here`,
because brew never checked them and `bumpii` is what does. And a tracked
formula brew does not have installed goes under `tracked, not installed`: brew
is exactly as silent about that as about a current one, so the two have to be
told apart by asking `brew list`, not by its silence.

Reference counts are taken across every name a tool answers to, not just the
one brew prints. `forgejo-cli` ships `fj`, and counting brew's name alone found
that tool in one file instead of nineteen — which is not merely a mis-ranking,
it is `no file in your usagePaths names these` printed about something named in
nineteen of them.

`★ pending, not digested` is its own section rather than a variant of the
first, because nothing there was read: the engine was off, it failed, or the
forge published nothing between the two versions. The body says which. A shared
heading would have the report contradicting the line underneath it, and the
tally at the bottom counts every bucket for the same reason — including the two
that mean *bumpii could not check*, which are the numbers worth seeing.

Compare links are built from the tags the forge really published, on **both**
ends, never from the version numbers: jq tags `jq-1.8.2` and gh tags `v2.97.0`,
so a constructed tag is a 404 that reads as a broken tool. Where either end is
not a published release — brew offering a revision bump (`1.2.3` → `1.2.3_2`)
that was never tagged — no link is shown at all, because a link to
`compare/v1.2.3...v1.2.4` would work perfectly and describe a release the
upgrade does not contain. In a terminal that supports OSC 8 every URL is also clickable, and
the resolved repos are cached in `~/.config/bumpii/sources.json` — a derived
file, safe to delete.

## The releases GitHub already told you about

Watching a repo queues one notification per release — including releases
nothing else here can see: apps brew does not manage, npm-installed CLIs, and
the prereleases a nightly channel actually runs on. `bumpii inbox` reads
exactly that queue — your unread notifications of type Release — and digests
it like everything else:

```console
$ bumpii inbox
anthropics/claude-code → v2.1.226  3 releases  tracked as claude
  ! security  Sandbox deny entries with a trailing slash were silently bypassable (v2.1.224)
      you use this: ~/ops/scripts/worker.sh
  · fix       Transient 401 no longer replaces a long-lived OAuth token (v2.1.225)
  affects you: 1 of 12 changes touch commands you call

jundot/omlx → v0.5.8.dev2  2 releases  prerelease
  + feature  Ling 3.0 Flash support for FP8 and mixed FP4/FP8 checkpoints (v0.5.8.dev1)
  affects you: none of these touch commands you call

5 other unread notifications — 3 Issue · 2 PullRequest — github.com/notifications
engine: claude-cli/haiku
```

A repo a `tools.json` entry already points at is searched under that entry's
name — `anthropics/claude-code` is called `claude` in scripts, and searching
its notes under the repo name would miss every span the search exists to find.
An untracked repo falls back to its short name, which under-reports relevance
when the binary is named differently — the safe direction for a guess.

Prereleases are flagged, never filtered. The other commands drop them because
`brew upgrade` will never hand you one; here the subscription is you saying
you want these, and a machine on a nightly channel gets its release news from
nowhere else. The rest of the inbox — issues, PRs, CI — is counted, never
expanded: this command reads release news, and reporting "inbox zero" while
issue threads pile up would claim more than it checked.

`--mark-read` marks the shown release threads read afterwards, each thread
individually — never the whole-inbox sweep, which would also clear the issues
and PRs this command deliberately does not touch. An entry whose release
bodies could not be fetched keeps its threads unread: nothing was shown, and
the notification is the only reminder it exists.

This is the one command that cannot run anonymously — GitHub's /notifications
endpoint has no unauthenticated form — so it needs `gh auth login` or a
`GITHUB_TOKEN`, the same sources the rest of the tool already uses.

## Adding tools

For anything installed via Homebrew, let it write the entry:

```console
$ bumpii scan                       # installed formulae you don't track yet
44 installed formula(e) not tracked:
  bat bats-core cmake gitleaks jq restic shellcheck tea uv …

$ bumpii add tea gitleaks uv
tea → tea 0.14.2
  source: https://gitea.com/gitea/tea
  probe:  tea --version → Version: 0.14.2	golang: 1.26.4
  update: brew upgrade tea
…
added to ~/.config/bumpii/tools.json: tea, gitleaks, uv
```

Everything is derived from what is already on the machine: brew knows the
upstream tarball URL (hence the forge repo), which binaries the formula
installs — `forgejo-cli` ships `fj`, so the entry is keyed on the binary — and
which version is current.

The one thing brew cannot say is how a binary reports its own version, so
`bumpii` probes `--version`, `version`, `-V`, `-v` and **validates the probe
against the version brew already knows**. A regex that matched nothing would
make the tool look permanently "not installed"; requiring it to reproduce the
known version is what makes a generated entry trustworthy. Colour is stripped
first, so a CLI that bolds its version number (`tea` does) still yields a
portable regex.

`--dry-run` shows the entries without writing. A formula whose source cannot
be determined is reported and skipped rather than guessed at — a plain tarball
mirror (`ftp.gnu.org/gnu/wget/…`) looks like `owner/repo` but is not a forge,
and an entry built from it would 404 on every run.

`scan` lists `brew leaves` — what you asked for, not the dependencies dragged
in behind them.

### What arrived, and what nothing calls

Two more questions the same data answers, and both are `scan` with a flag.

`--new` is what changed on the machine recently:

```console
$ bumpii scan --new
1 formula(e) you asked for, installed or upgraded in the last 14 days:
  php@8.1  8.1.34  2026-08-04

51 dependencies came in behind them — --deps to list those too

brew records one time per install, so an upgrade is indistinguishable from a
first install — this is what changed on the machine, not what is new to it.

not tracked yet:
  bumpii add php@8.1
```

The window is a duration (`--since 30d`, `--since 3w`, default 14 days), not a
remembered "last run": nothing else here keeps state, and a stored timestamp
would make the same command answer differently depending on whether an earlier
run was interrupted, with nothing in the output to say so. What you asked for
and what came in behind it are separated because they have to be — one
`brew install php@8.1` put 77 formulae in the window on the machine this was
built on, 76 of them dependencies.

`--unref` is the honest half of the "unused" question:

```console
$ bumpii scan --unref
2 of 46 leaves are named in nothing you wrote:
  mpv     requested
  libpng  dependency

searched: ~/.claude/skills ~/ops/scripts ~/dotfiles
this is not "you never use it" — only that no file in those paths names it,
and nothing here can see an interactive shell.
```

**It does not claim a tool is unused, and the wording is the feature.** There
is no way to know whether you ever ran a binary without reading your shell
history, which this tool will not do. What it can say is checkable: it greps
the same `usagePaths` the report greps, for each leaf's own name and for every
binary that leaf installs — `forgejo-cli` ships `fj`, and searching only the
formula name would report it as unmentioned while every script calls it.

Matching is substring, not word-boundary, on purpose: "jq" inside "jquery"
counts as a mention. That over-reports a name as used, and over-reporting is
the safe direction when the claim being made is the absence. With no usable
`usagePaths` the command refuses to run at all rather than report everything
as unreferenced.

The `requested`/`dependency` column is brew's own record of why each formula
is there. A leaf marked `dependency` came in behind something else and now has
nothing depending on it — the strongest candidate on the list.

### Containers

For anything running as a container, `--image` reads the entry off it:

```console
$ bumpii add --image gateway grafana
gateway (podman) → gateway 2.4.1
  source: github:owner/gateway
  probe:  image ghcr.io/owner/gateway:2.4.1
  update: # complete this: pull ghcr.io/owner/gateway:2.4.1 and restart gateway
```

`scan --image` is the container half of `scan` — what is running that you are
not watching:

```console
$ bumpii scan --image
2 running container(s) not tracked (podman):
  grafana   docker.io/grafana/grafana:11.4.0
  pg        postgres:17-alpine

add the ones whose release notes you want:
  bumpii add --image grafana pg
```

It matches on the container name, not the image: two containers can run the
same image, so the name is the only key an entry can have. An entry you
renamed by hand still counts as tracking its container, because the name is
also read off the `inspect` command the entry probes with. The inverse case —
an entry whose container no longer exists — needs no separate command; it
reports itself at digest time.

This path is more reliable than the Homebrew one, because it does not have to
guess. `org.opencontainers.image.source` is part of the OCI image spec and its
whole purpose is to say where the code lives, whereas brew only offers a
tarball URL to extract a repo address from. podman and docker are driven
identically here — same `inspect --format`, same labels — so whichever is on
PATH answers.

**Roughly half of common images do not carry the label.** Measured: traefik,
prometheus and home-assistant do; postgres, nginx and grafana have none at all
— postgres carries no labels whatsoever, grafana only a maintainer address.
For those, three ways to supply the repo:

```console
$ bumpii add --image pg --source github:postgres/postgres   # hand it over
$ bumpii add --image pg                                     # or leave it open
$ bumpii set pg source github:postgres/postgres             # and fill it in later
```

An entry without a source is still written, because everything else about it
is worked out and it is one line from working. It is not silently ignored
either: `bumpii list` shows what is missing, and the report says "needs a
source" rather than treating it as broken or, worse, as fine.

It will not guess the repo from the image path, and one example says why:
`ghcr.io/home-assistant/home-assistant` is built from
`github.com/home-assistant/core`. A guess off the path lands on a different
repo that also exists, and you would be reading someone else's release notes
without any sign that anything went wrong.

The `update` line is likewise left as a comment for you to finish: pulling is
only half an update, the container still has to be restarted onto the new
image, and how depends on how you run it. Until you complete that line,
`--yes` skips the entry and exits non-zero rather than running a comment and
calling it a success — which is what `sh -c` would otherwise do, happily and
with exit 0.

One honest limitation: the "affects you" verdict is weaker here. It works by
grepping your files for the commands a change touches, and a service usually
has no commands that appear in your scripts — so expect "affects you: none"
more often, and read it as "nothing to grep for" rather than "nothing that
matters". The digest itself is unaffected: what changed, and whether any of it
is a security or breaking change, is the same question either way.

A container update is also exactly what
[revertii](https://github.com/bmmmm/revertii) is for: it applies the change,
checks health, and puts the old image back if the service does not return.
`update` can simply be `revertii update gateway`.

## Configure

Or write entries by hand. `~/.config/bumpii/tools.json`:

```json
{
  "usagePaths": ["~/.claude/skills", "~/ops/scripts", "~/dotfiles"],
  "tools": [
    {
      "name": "gh",
      "source": "github:cli/cli",
      "version": { "cmd": ["gh", "--version"], "match": "gh version ([0-9][0-9.]*)" },
      "update": "brew upgrade gh"
    }
  ]
}
```

- **`usagePaths`** — where "do I use this?" is answered. Point it at whatever
  holds your scripts, skills and dotfiles.
- **`source`** — `github:owner/repo`, `codeberg:owner/repo`, or a full URL to
  any Forgejo/Gitea instance (`https://git.example.com/team/app`).
- **`version.cmd`** — argv, never a shell string. `version.match` is a regex
  with one capture group. Not every CLI agrees on `--version`: `fj` wants
  `fj version`, and some print to stderr — both are handled.
- **`update`** — whatever bumps it on your machine. Only ever run with `--yes`.
  A tool with no CLI trigger at all (an app that updates itself) takes
  `manual: <where to click>` — a complete entry that `--yes` skips as routine,
  unlike a `#`-comment, which marks an entry still waiting to be finished.

`bumpii add` rewrites this file, and it writes back the whole document: an
entry you tuned by hand is never replaced, and any key bumpii does not know
about survives untouched. The same holds for `set` and `rm`.

### Rolling channels (nightlies)

Some projects ship their nightlies as one mutable release under a fixed tag —
Ghostty's `tip` is rebuilt on every commit to main, and the release's notes
never change. There is nothing there to digest: the actual news is the commit
log between the build you run and the commit the tag points at now. A `channel`
entry reads exactly that:

```json
{
  "name": "ghostty",
  "source": "github:ghostty-org/ghostty",
  "channel": "tip",
  "version": { "cmd": ["ghostty", "--version"], "match": "\\+([0-9a-f]{7,40})" },
  "update": "manual: Ghostty updates itself — menu Ghostty, Check for Updates"
}
```

- **`channel`** — the tag the rolling release lives under. With it set,
  `version.match` must capture the **commit hash** of the installed build, not
  a version number; a nightly's version string carries one for exactly this
  reason (`Ghostty 1.3.2-main-+b0b9fbc8d`).
- The digest then comes from the forge's compare endpoint: the commits between
  your build and the channel's head, judged like release notes and grepped
  against your usagePaths like everything else. The report counts honestly in
  commits ("41 commits behind on tip"), and the raw-notes fallback links the
  compare view.
- A build whose commit is not on the channel's history — a local build, or a
  force-pushed main — is reported as such rather than measured against a
  history it is not on.

### Managing entries

```console
$ bumpii list                              # what is tracked, and what is incomplete
gh                   github:cli/cli
pg                   —                     needs: source, update

$ bumpii set pg source github:postgres/postgres
$ bumpii set pg update "docker pull postgres:17 && docker restart pg"
$ bumpii rm pg
no longer tracked: pg
```

`set` only touches `source` and `update` — the two fields an entry can be
incomplete in. `version.cmd` is argv and `version.match` is a regex; setting
either from a single string argument would just be a more convenient way to
write a broken entry, so those stay with the file. `rm` on something that is
not tracked is an error, not a silent success, because the usual cause is a
typo you would otherwise never see.

## Use

```console
$ bumpii                  # this help — nothing is fetched, nothing is judged
$ bumpii digest           # digest everything, change nothing (exit 1 if anything is pending)
$ bumpii --only gh        # one tool
$ bumpii --no-judge       # no model: just list pending releases and their URLs
$ bumpii --json           # machine-readable, for a scheduled run
$ bumpii digest --yes     # digest, then run each update command
$ bumpii digest --yes --dry-run   # print those commands, run none of them
```

`--dry-run` is worth a look before the first unattended `--yes`: the update
lines come from a config this tool never wrote, and it prints them as they
are rather than describing them. It also reports an unfinished placeholder
(`# complete this: …`) as the failure it would be — `sh -c` runs a comment
happily and exits `0`, so a real `--yes` would report an update that never
happened. Nothing was updated, so the exit code stays the digest's own: `1`
while something is still pending.

The digest has to be named. It is the most expensive thing here — a forge
round-trip per tool and a model that can spend minutes on one release — and
the bare name is the easiest command in the world to run by accident, so the
bare name prints help instead. Any argument at all is taken as meaning it,
which is why the `--only` and `--json` forms above still digest and no
existing script or cron line changes.

Read-only is the default and updating is never implied: the point is to know
what is in a release before you take it. `--yes` exists for the unattended
case; it prints the digest first regardless.

Exit codes: `0` nothing pending, `1` updates available, `2` error. `0` means
*checked, and nothing was waiting* — so a run where a forge could not be
reached exits `2` even though nothing came back pending, because nothing was
checked either. Under `--yes` there is nothing left pending by definition, so
it exits `0` when every update ran and `2` when any of them failed — an
unattended run has to be able to say it did not work. The `1` is there so a
scheduled run can act on it:

```console
0 9 * * 1  bumpii --json > ~/tmp/bumpii.json || notify "tool updates pending"
```

**Keep the report and the config out of your repos.** A `--json` run carries
`hits[].file` — absolute paths into your own scripts — so committing one
publishes both the layout of your machine and the tool inventory it was judged
against. `tools.json` says the same thing more directly, in its `usagePaths`
and its list of everything you watch. Neither is written into a working tree by
default (the config and the resolved-source cache live under
`~/.config/bumpii/`), but a redirect like the one above is one `cd` away from
landing in a project, so this repo's `.gitignore` names them and yours should
too:

```gitignore
tools.json
sources.json
bumpii.json
bumpii-*.json
```

Two states are deliberately not folded into "up to date", because both mean
bumpii could not check rather than checked and found nothing:

- **`unknown`** — the forge publishes no versioned release. A repo that only
  tags, or that ships a rolling `stable`/`nightly` pointer, gives nothing that
  can be ordered against your installed version.
- **`usagePaths not found`** — a configured path does not exist, so nothing
  was searched there and every "affects you" verdict above it is incomplete.

A count reads as **`30+`** when the forge's first page of releases was full
and every one of them was pending — the page boundary ended the list, not your
version, so the real gap is larger.

### While it works

Everything slow here is silent — a GET per forge, a model that may take
minutes over one release, `brew outdated` on a machine with hundreds of
formulae — so a run prints a progress line to keep the wait honest:

```console
   ⡀     v0.1.4  reading changelogs nobody reads 7/12 12s
    \▄/  *BUMP*  reading changelogs nobody reads 7/12 12s
  ·⠛⠛⠛·  v0.1.5  reading changelogs nobody reads 8/12 12s
```

A ball drops, lands, and the landing bumps a version. It is paced rather than
ticked: the ball hangs at the top, accelerates into the floor, loses height
with each landing and then rolls for nearly two seconds before something shoves
it back up — which is the stretch slow enough to read a sentence over. Small
landings take the patch, the shove out of the roll takes the minor.

The counts beside it are
the run's own — tools finished out of tools asked about — and so is the
sentence: each one is only eligible while a predicate over the measured state
holds, so `34 releases behind` appears when there really are thirty-four and
never as filler. A line that guessed would be the same failure as a report that
guessed.

It writes to **stderr only**, and only to a terminal. Piping, redirecting,
`--json`, cron and CI all produce byte-identical output to a run without it:

| Condition | Effect |
| --- | --- |
| stderr is not a TTY | silent |
| `CI` is set | silent |
| `TERM=dumb` | silent |
| `BUMPII_NO_PROGRESS` is set | silent |
| `NO_COLOR` is set | drawn, without colour |

Nothing is drawn for the first 220ms either, so commands that were never slow
stay clean.

Ctrl-C is a supported way to leave a long run: it puts the cursor back, and it
takes the running child with it — a judge is a `claude` invocation that may
have minutes of work left, and `--yes` runs `brew upgrade`. It exits `130`,
the conventional code for a run ended by SIGINT.

### What it is not

Not a package manager — it never resolves or installs anything, it runs the
`update` command you wrote. Not a vulnerability scanner: it reports what a
release says about itself, so an unmentioned CVE stays unmentioned. And not a
fact-checker of those claims — for "are these notes even true?", the sibling
tool [comparereleaseii](https://github.com/bmmmm/comparereleaseii) verifies
release notes against the actual code diff.

## Engine

Any OpenAI-compatible server is preferred, so notes stay on your machine:

```console
$ export OPENAI_BASE_URL=http://127.0.0.1:8080/v1   # oMLX, Ollama, vLLM, LM Studio
$ bumpii digest
```

No model is hardcoded — `/v1/models` is asked what it serves, and `--model`
overrides. Without `OPENAI_BASE_URL`, the `claude` CLI is used if present. The
engine is always named in the footer, because a summary is worth exactly as
much as your trust in who wrote it.

### Without any engine at all

`bumpii` is useful with no model anywhere, and that is not an afterthought.
Everything mechanical still works — what is outdated, which of it your own
files name, the compare and release links, the exit codes — and instead of a
digest you get the notes' own URLs plus this:

```console
$ bumpii digest
gh 2.95.0 → 2.97.0  2 releases behind
  no digest — none (no engine reachable); raw notes:
    2.96.0  https://github.com/cli/cli/releases/tag/v2.96.0
    2.97.0  https://github.com/cli/cli/releases/tag/v2.97.0
  mentions commands you call, though nothing judged which change:
    gh auth status — ~/ops/scripts/release.sh, ~/ops/scripts/setup.sh +8 more
    gh pr diff — ~/ops/scripts/merge.sh, ~/ops/scripts/review.sh +2 more
  → brew upgrade gh
```

Those command strings are read straight out of the notes' inline code spans —
no model involved — and grepped against your files exactly as the digested
verdict is. A span is kept only when it names the tool as a word and clears the
same specificity bar the model's output has to: on gh's real 2.97.0 notes that
keeps `gh auth status` and `gh attestation verify` while dropping `gh api` (a
group, not a surface) and `github_pat_*`, `ghs_*`, `ghu_*` (token formats that
merely contain "gh").

**The wording is the point.** It says *mentions*, not *affects you*: nothing
here knows which change a string belongs to, so the claim stops exactly where
the evidence does. What it can support is that the string is in the notes and
in that file — which, in the run above, is how a machine with no LLM finds that
the 2.97.0 token-leak fix is about the one gh command it calls ten times over.

A local model is still worth the ten minutes: `ollama serve` or LM Studio, one
`OPENAI_BASE_URL`, and the digest runs offline, free, and on your own hardware.
`--no-judge` takes this same path deliberately when you have an engine and do
not want to spend it.

## Behind a proxy

Node's `fetch` ignores `HTTP_PROXY` unless told otherwise, which shows up as a
bare `fetch failed` while `curl` works fine. The launcher sets
`NODE_USE_ENV_PROXY=1` when a proxy is configured, so this should just work.

## Rate limits

Every run fetches releases fresh — no cache, no conditional requests — so an
unauthenticated forge caps how much this scales. GitHub's anonymous limit is
60 requests/hour, one per tracked tool per run: fine for a handful of tools
run on a cron, tight if you track two dozen and also iterate on the config by
hand.

**If `gh` is logged in, that is already handled.** With no token in the
environment, `bumpii` asks `gh auth token` and uses what it gets — 5000
requests/hour, from the login you already have, without configuring a second
copy of it. It is only ever used for `github:` sources; Codeberg and
self-hosted Forgejo never see it.

Otherwise, or to use a narrower token than the one `gh` holds, set it
yourself — an environment variable always wins over `gh`:

```console
$ export GITHUB_TOKEN=…      # or GH_TOKEN — for github: sources
$ export CODEBERG_TOKEN=…    # for codeberg: sources
$ export FORGEJO_TOKEN=…     # for any other https:// Forgejo/Gitea source
```

Each token is only ever sent to the host it belongs to (`sources.ts`) — a
GitHub token never reaches a self-hosted Forgejo, and vice versa.

## Development

```console
$ pnpm install         # typescript, @types/node, biome — all dev-only
$ pnpm check           # tsc --noEmit
$ pnpm lint            # biome check
$ pnpm format          # biome check --write
$ pnpm test            # node:test
```

CI runs all three on Linux and macOS. macOS is not redundant: `add`/`scan` are
built on brew, the launcher resolves symlinks in POSIX `sh` without GNU
`readlink`, and the usage verdict shells out to grep — none of which Linux
exercises against the userland they actually ship on.

Three languages, and only one of them is load-bearing:

- **TypeScript** — the tool. Honest caveat: this is roughly 1300 lines that
  `curl`, `jq` and `grep` could have carried in fewer, and a shell version
  would have sat more naturally next to the scripts this thing was written to
  serve. What the type checker did earn: it caught an unchecked `argv[i]`, and
  per-tool error isolation across concurrent fetches is cleaner here than
  collecting exit codes from background jobs. Not enough to call it the
  obvious choice — it was picked to match its sibling project, which is not a
  reason.
- **Shell** — `bin/bumpii`, and it has to be: the proxy opt-in and the symlink
  resolution both have to happen before Node starts.
- **Python** — only `assets/make-logo-gif.py`, run through `uvx` when the logo
  changes. Never imported, never installed.

The logo is regenerable rather than a hand-made binary: `assets/logo-source.png`
is the flat export, and `uvx --from pillow python assets/make-logo-gif.py`
lifts the capsule out of it and animates the bounce. Re-export the source and
re-run the script instead of editing the GIF.

## Contributing

Bug reports want particular evidence — the raw output of a version probe, the
project's real tag names, whether grep finds a string bumpii did not. The
[issue forms](https://github.com/bmmmm/bumpii/issues/new/choose) ask for it
per report class, and [CONTRIBUTING.md](CONTRIBUTING.md) explains why each
one settles the question it does. Security issues go
[privately](SECURITY.md), never in a public issue.

## Support

If this is useful to you, [ko-fi.com/bmabma](https://ko-fi.com/bmabma).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
