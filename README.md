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
$ pnpm install
$ ln -sf "$PWD/bin/bumpii" ~/.local/bin/bumpii
$ bumpii init          # writes ~/.config/bumpii/tools.json
```

Node 24+ (runs the TypeScript directly, no build step). `pnpm`, not npm — the
`preinstall` guard will say so.

## Configure

`~/.config/bumpii/tools.json`:

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

Exit codes: `0` nothing pending, `1` updates available, `2` error.

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
$ pnpm check   # tsc --noEmit
$ pnpm test    # node:test
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
