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
$ bumpii
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
| `bumpii` | digest pending releases for everything tracked |
| `bumpii init` | write a starter config |
| `bumpii add <formula>…` | derive entries from installed Homebrew formulae |
| `bumpii add --image <container>…` | derive entries from running containers |
| `bumpii scan` | installed formulae not yet tracked |
| `bumpii list` | what is tracked, and what is still incomplete |
| `bumpii set <name> <field> <value>` | change one field: `source` or `update` |
| `bumpii rm <name>…` | stop tracking these |
| `bumpii --yes` | digest, then run each tool's update command |

`bumpii --help` carries the options; the sections below cover what each of
these does and why.

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

### Containers

For anything running as a container, `--image` reads the entry off it:

```console
$ bumpii add --image gateway grafana
gateway (podman) → gateway 2.4.1
  source: github:owner/gateway
  probe:  image ghcr.io/owner/gateway:2.4.1
  update: # complete this: pull ghcr.io/owner/gateway:2.4.1 and restart gateway
```

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

`bumpii add` rewrites this file, and it writes back the whole document: an
entry you tuned by hand is never replaced, and any key bumpii does not know
about survives untouched. The same holds for `set` and `rm`.

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
$ bumpii                  # digest everything, change nothing (exit 1 if anything is pending)
$ bumpii --only gh        # one tool
$ bumpii --no-judge       # no model: just list pending releases and their URLs
$ bumpii --json           # machine-readable, for a scheduled run
$ bumpii --yes            # digest, then run each update command
```

Read-only is the default and updating is never implied: the point is to know
what is in a release before you take it. `--yes` exists for the unattended
case; it prints the digest first regardless.

Exit codes: `0` nothing pending, `1` updates available, `2` error. Under
`--yes` there is nothing left pending by definition, so it exits `0` when
every update ran and `2` when any of them failed — an unattended run has to be
able to say it did not work. The `1` is there so a scheduled run can act on it:

```console
0 9 * * 1  bumpii --json > ~/tmp/bumpii.json || notify "tool updates pending"
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
$ bumpii
```

No model is hardcoded — `/v1/models` is asked what it serves, and `--model`
overrides. Without `OPENAI_BASE_URL`, the `claude` CLI is used if present.
Without either, `bumpii` degrades to `--no-judge` behaviour and says so:
pending releases and their URLs, no digest. The engine is always named in the
footer, because a summary is worth exactly as much as your trust in who wrote
it.

## Behind a proxy

Node's `fetch` ignores `HTTP_PROXY` unless told otherwise, which shows up as a
bare `fetch failed` while `curl` works fine. The launcher sets
`NODE_USE_ENV_PROXY=1` when a proxy is configured, so this should just work.

## Rate limits

Every run fetches releases fresh — no cache, no conditional requests — so an
unauthenticated forge caps how much this scales. GitHub's anonymous limit is
60 requests/hour, one per tracked tool per run: fine for a handful of tools
run on a cron, tight if you track two dozen and also iterate on the config by
hand. Set a token to raise it:

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
