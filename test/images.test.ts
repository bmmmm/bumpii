// SPDX-License-Identifier: GPL-3.0-or-later
// Deriving an entry from a running container, against a fixture runtime on
// PATH. Stubbed rather than mocked on purpose: what is worth pinning down is
// the argv bumpii builds and how it reads the reply, and both only exist when
// something is actually executed.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { discoverImage, versionFrom } from "../src/images.ts";

let dir: string | null = null;
const realPath = process.env.PATH;

/**
 * Put a fake `podman` on PATH. Its body is a shell case over the --format
 * argument, which is also the point: the real runtimes are driven the same way.
 */
async function stubRuntime(body: string): Promise<void> {
  dir ??= await mkdtemp(join(tmpdir(), "bumpii-image-"));
  const p = join(dir, "podman");
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
  // Prepended, so the fixture wins over any real podman on the machine.
  process.env.PATH = `${dir}:${realPath}`;
}

after(async () => {
  process.env.PATH = realPath;
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A runtime that answers every label bumpii asks for. */
const COMPLETE = `
case "$1" in
  --version) echo "podman version 5.2.0"; exit 0 ;;
esac
case "$3" in
  *"image.source"*)  echo "https://github.com/owner/app" ;;
  *"image.version"*) echo "2.4.1" ;;
  "{{.Config.Image}}") echo "ghcr.io/owner/app:2.4.1" ;;
  *) echo "<no value>" ;;
esac
`;

test("versionFrom prefers the label over the tag", () => {
  // A tag is a moving pointer; the label is a statement about the build.
  assert.equal(versionFrom("2.4.1", "ghcr.io/owner/app:latest"), "2.4.1");
  assert.equal(versionFrom("  2.4.1  ", "x:1.0"), "2.4.1");
});

test("versionFrom falls back to the tag only when it carries digits", () => {
  assert.equal(versionFrom("", "ghcr.io/owner/app:2.4.1"), "2.4.1");
  // "latest" recorded as a version would compare as older than everything and
  // render as permanently up to date — the quiet wrong answer again.
  assert.equal(versionFrom("", "ghcr.io/owner/app:latest"), "");
  assert.equal(versionFrom("", "ghcr.io/owner/app:stable"), "");
  assert.equal(versionFrom("", "ghcr.io/owner/app"), "");
});

test("versionFrom takes the number out of a decorated tag", () => {
  // postgres:17-alpine is the live case. Returning "17-alpine" here while the
  // generated regex reports "17" on every later run makes the version appear
  // to change between `add` and the first digest.
  assert.equal(versionFrom("", "postgres:17-alpine"), "17");
  assert.equal(versionFrom("", "app:v3.2.5-rc1"), "3.2.5");
});

test("a container with the OCI labels yields a complete entry", async () => {
  await stubRuntime(COMPLETE);
  const d = await discoverImage("app");

  assert.equal(d.runtime, "podman");
  assert.equal(d.version, "2.4.1");
  assert.equal(d.source, "github:owner/app", "the source label is a plain repo URL");
  assert.equal(d.entry.name, "app");
  assert.deepEqual(d.entry.version.cmd.slice(0, 2), ["podman", "inspect"]);
  assert.match(d.entry.version.match, /\[0-9\]/);
});

test("the generated version command actually resolves against the runtime", async () => {
  // The regex is generated, so it has to be checked against the output it will
  // face — a pattern that matches nothing would make the tool look permanently
  // "not installed".
  await stubRuntime(COMPLETE);
  const d = await discoverImage("app");
  const { installedVersion } = await import("../src/version.ts");
  assert.equal(await installedVersion(d.entry), "2.4.1");
});

test("without a version label the tag is read off the running container", async () => {
  await stubRuntime(`
case "$1" in
  --version) echo "podman version 5.2.0"; exit 0 ;;
esac
case "$3" in
  *"image.source"*)  echo "https://github.com/owner/app" ;;
  *"image.version"*) echo "<no value>" ;;
  "{{.Config.Image}}") echo "ghcr.io/owner/app:2.4.1" ;;
esac
`);
  const d = await discoverImage("app");
  assert.equal(d.version, "2.4.1");
  assert.deepEqual(d.entry.version.cmd.slice(-2), ["{{.Config.Image}}", "app"]);

  const { installedVersion } = await import("../src/version.ts");
  assert.equal(await installedVersion(d.entry), "2.4.1");
});

test("an image without the source label yields a draft, not a refusal", async () => {
  // Measured against real images: postgres and nginx carry no source label at
  // all, grafana only a maintainer address. Refusing would leave the fiddly
  // part — the inspect argv and its regex — to be written by hand for the
  // commonest case.
  await stubRuntime(`
case "$1" in
  --version) echo "podman version 5.2.0"; exit 0 ;;
esac
case "$3" in
  "{{.Config.Image}}") echo "docker.io/library/nginx:1.27" ;;
  *) echo "<no value>" ;;
esac
`);
  const d = await discoverImage("web");
  assert.equal(d.needsSource, true);
  assert.equal(d.source, "");
  assert.equal(d.version, "1.27", "everything else is still worked out");
  assert.deepEqual(d.entry.version.cmd.slice(0, 2), ["podman", "inspect"]);
});

test("a source label that is not a forge URL also yields a draft", async () => {
  await stubRuntime(`
case "$1" in
  --version) echo "podman version 5.2.0"; exit 0 ;;
esac
case "$3" in
  *"image.source"*)  echo "https://example.com/downloads/app.tar.gz" ;;
  *"image.version"*) echo "1.0.0" ;;
  "{{.Config.Image}}") echo "app:1.0.0" ;;
esac
`);
  const d = await discoverImage("app");
  assert.equal(d.needsSource, true);
  assert.equal(d.version, "1.0.0");
});

test("the repo is never derived from the image path", async () => {
  // ghcr.io/home-assistant/home-assistant is built from
  // github.com/home-assistant/core — verified against the real image. A guess
  // off the path lands on a different, existing repo and would report someone
  // else's release notes, which is worse than no answer.
  await stubRuntime(`
case "$1" in
  --version) echo "podman version 5.2.0"; exit 0 ;;
esac
case "$3" in
  *"image.source"*)  echo "https://github.com/home-assistant/core" ;;
  *"image.version"*) echo "2024.1.0" ;;
  "{{.Config.Image}}") echo "ghcr.io/home-assistant/home-assistant:2024.1.0" ;;
esac
`);
  const d = await discoverImage("ha");
  assert.equal(d.source, "github:home-assistant/core");
  assert.notEqual(d.source, "github:home-assistant/home-assistant");
  assert.equal(d.needsSource, false);
});

test("an image with no version anywhere is refused", async () => {
  await stubRuntime(`
case "$1" in
  --version) echo "podman version 5.2.0"; exit 0 ;;
esac
case "$3" in
  *"image.source"*)  echo "https://github.com/owner/app" ;;
  *"image.version"*) echo "<no value>" ;;
  "{{.Config.Image}}") echo "ghcr.io/owner/app:latest" ;;
esac
`);
  await assert.rejects(discoverImage("app"), /carries a version number/);
});

test("a container the runtime does not know names itself in the error", async () => {
  await stubRuntime(`
case "$1" in
  --version) echo "podman version 5.2.0"; exit 0 ;;
esac
echo "Error: no such object: nope" >&2
exit 125
`);
  await assert.rejects(discoverImage("nope"), /nope: podman could not inspect it/);
  await assert.rejects(discoverImage("nope"), /no such object/);
});
