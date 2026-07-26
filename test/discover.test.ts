// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/cli.ts";
import { sourceFromUrls } from "../src/discover.ts";
import { stripAnsi } from "../src/version.ts";

test("sourceFromUrls maps the shorthand forges", () => {
  assert.equal(
    sourceFromUrls(["https://github.com/cli/cli/archive/refs/tags/v2.96.0.tar.gz"]),
    "github:cli/cli",
  );
  // codeberg is .org, not .com — the first version of this regex assumed .com
  // and silently failed on exactly the two Forgejo tools it was written for.
  assert.equal(
    sourceFromUrls(["https://codeberg.org/forgejo-contrib/forgejo-cli/archive/v0.6.0.tar.gz"]),
    "codeberg:forgejo-contrib/forgejo-cli",
  );
});

test("sourceFromUrls keeps other Gitea/Forgejo hosts as full URLs", () => {
  // gitea.com serves the same /api/v1 shape, so the URL form is enough.
  assert.equal(
    sourceFromUrls(["https://gitea.com/gitea/tea/archive/v0.14.2.tar.gz"]),
    "https://gitea.com/gitea/tea",
  );
});

test("sourceFromUrls falls through the list to a usable url", () => {
  assert.equal(
    sourceFromUrls(["https://example.com/tarballs/foo.tar.gz", "", "https://github.com/o/r"]),
    "github:o/r",
  );
});

test("sourceFromUrls returns null rather than a wrong guess", () => {
  assert.equal(sourceFromUrls(["https://ftp.gnu.org/gnu/wget/wget-1.25.tar.gz"]), null);
  assert.equal(sourceFromUrls([""]), null);
});

test("stripAnsi removes SGR colour so a version regex stays portable", () => {
  // Real `tea --version` output: the number arrives bold.
  assert.equal(stripAnsi("Version: \x1b[1m0.14.2\x1b[0m\tgolang: 1.26.4"), "Version: 0.14.2\tgolang: 1.26.4");
  assert.equal(stripAnsi("gh version 2.96.0"), "gh version 2.96.0");
});

test("parseArgs routes the subcommands and collects positionals", () => {
  const add = parseArgs(["add", "tea", "gitleaks", "--dry-run"]);
  assert.equal(add.cmd, "add");
  assert.deepEqual(add.rest, ["tea", "gitleaks"]);
  assert.equal(add.dryRun, true);

  assert.equal(parseArgs(["scan"]).cmd, "scan");
  assert.equal(parseArgs(["init"]).cmd, "init");
});

test("parseArgs treats a subcommand-looking positional as an argument", () => {
  // A formula genuinely called "scan" must not re-route the command.
  const a = parseArgs(["add", "scan"]);
  assert.equal(a.cmd, "add");
  assert.deepEqual(a.rest, ["scan"]);
});
