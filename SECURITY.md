# Security policy

## Reporting

Report privately through [GitHub's private vulnerability
reporting](https://github.com/bmmmm/bumpii/security/advisories/new) — not as a
public issue, and not in a pull request. A fix and a patched version come
before any public description of the problem.

Expect a first reply within a week. This is a single-maintainer project, so
that is a realistic estimate rather than a service commitment.

## What is in scope

bumpii reads release notes and probes binaries you told it about, so its
exposure is narrower than a package manager's — but not zero:

- **Token leakage across hosts.** A token is only ever sent to the forge it
  belongs to: `GITHUB_TOKEN`/`GH_TOKEN` to github.com, `CODEBERG_TOKEN` to
  codeberg.org, `FORGEJO_TOKEN` to anything else. Any path where a credential
  reaches a host it was not issued for is a vulnerability, including through
  a redirect or a crafted `source` value.
- **Command execution from config or release notes.** `version.cmd` is argv,
  never a shell string, precisely so a `;` in a config file cannot start a
  second command. Anything that turns forge content, release-note text or a
  config value into executed code is in scope.
- **Path escape in the usage search.** `usagePaths` decides what gets
  grepped; a way to make bumpii read outside them counts.
- **Prompt content reaching an engine it should not.** With `OPENAI_BASE_URL`
  set, notes go to that server and nowhere else. A path that sends them
  elsewhere — or sends more than the notes — is in scope.

## What is not

- **`update` commands running under `--yes`.** That string is yours and runs
  through `/bin/sh` by design; `--yes` is what you type to authorise it. If
  someone can already edit your config, they can already run commands as you.
- **A malicious forge lying in its release notes.** bumpii reports what a
  release says about itself. Verifying those claims against the actual code
  diff is a different tool's job — see
  [comparereleaseii](https://github.com/bmmmm/comparereleaseii).
- **What a judge model writes in a summary.** A wrong or manipulated summary
  is a correctness bug — file it as one. The commands it extracts are only
  ever used as fixed-string grep needles, never executed.
- **Vulnerabilities in the tools bumpii tracks.** Report those upstream.

## Supported versions

The tip of `main`. There are no maintained release branches, and the
documented install is a clone plus a symlink — so `git pull` is the update
path for a fix.
