<p align="center">
  <img src="assets/logo.gif" alt="bumpii — a capsule mascot bouncing beside the wordmark" width="560">
</p>

# bumpii

Read what actually changed in the CLI tools you use every day — judged against
your own usage — then bump them.

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
`grep` for the usage verdict (present everywhere), and an engine for the
digest — see below.

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
about survives untouched.

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
