#!/usr/bin/env bash
# Create the labels the issue forms reference.
# Idempotent — reruns update colour and description in place.
# GitHub silently drops a label an issue form requests but that does not
# exist: no error, no warning, the issue is just created without it. Run this
# once after adding or changing the forms.
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

label() {
  gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force >/dev/null
  printf '  %s\n' "$1"
}

printf 'Labels for %s:\n' "$repo"

# One per bug class in .github/ISSUE_TEMPLATE — the class is the routing
# decision, so it belongs on the issue from the moment it is filed.
label version-probe "5319e7" "Reading the installed version of a tool"
label update-status "1d76db" "Which releases are pending, or whether any are"
label digest "0e8a16" "What the engine extracted from release notes"
label usage-verdict "fbca04" "Whether a change touches commands you call"
label discovery "c2e0c6" "bumpii add / bumpii scan deriving entries from brew"
label crash "b60205" "Unhandled error or non-zero exit that should not be"
label triage "ededed" "Not looked at yet"

printf 'Done. bug, enhancement and question are GitHub defaults and already exist.\n'
