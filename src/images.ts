// SPDX-License-Identifier: GPL-3.0-or-later
// Derive a tool entry from a running container.
//
// Same shape as discover.ts does for a Homebrew formula, one layer over: the
// container knows its image, and an OCI-conformant image carries the address
// of the repo it was built from. `org.opencontainers.image.source` is part of
// the image spec, which makes this more reliable than the brew path — there,
// the forge URL has to be guessed out of a tarball address by regex; here it
// is a field whose entire purpose is to say where the code lives.
//
// Deliberately runtime-agnostic: podman and docker take the same `inspect
// --format` arguments and read the same labels, because both implement the
// same spec. Whichever is on PATH is used.

import { type ExecError, run } from "./exec.ts";
import { sourceFromUrls } from "./sources.ts";
import type { ToolConfig } from "./types.ts";

export interface ImageDiscovery {
  container: string;
  image: string;
  version: string;
  /** Empty when the image carries no source label; `needsSource` is then set. */
  source: string;
  entry: ToolConfig;
  /** Which runtime answered, so the generated entry can be sanity-checked. */
  runtime: string;
  /**
   * The image did not say which repo it was built from, so the entry is a
   * draft: everything else is filled in, `source` is not, and it must not be
   * written to the config until a human supplies it.
   */
  needsSource: boolean;
}

/** Labels the OCI image spec defines for exactly this question. */
const LABEL_SOURCE = "org.opencontainers.image.source";
const LABEL_VERSION = "org.opencontainers.image.version";

/**
 * The container runtime to talk to. podman first: a host that has both is
 * usually a podman host with the docker shim installed, not the other way
 * round.
 */
export async function detectRuntime(): Promise<string> {
  for (const candidate of ["podman", "docker"]) {
    try {
      await run(candidate, ["--version"], { timeout: 10_000 });
      return candidate;
    } catch (err) {
      if ((err as ExecError).code !== "ENOENT") throw err;
    }
  }
  throw new Error("neither podman nor docker is on PATH — bumpii needs one of them for --image");
}

export interface RunningContainer {
  /** The name an entry would be keyed on. */
  name: string;
  /** Every name the runtime answers to for it — podman allows more than one. */
  names: string[];
  image: string;
}

/**
 * Running containers, by name and image.
 *
 * `ps` without `-a`: a stopped container has no version to compare and no
 * release worth reading, and listing one would be an invitation to track
 * something that is not running.
 *
 * The name field is not reliably a single token — docker separates several
 * with a comma, podman has printed them as a bracketed list — so it is split
 * rather than taken whole. Getting that wrong would mean offering to add a
 * container under a name its own runtime does not answer to.
 */
export async function runningContainers(runtime: string): Promise<RunningContainer[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(runtime, ["ps", "--format", "{{.Names}}\t{{.Image}}"], {
      timeout: 30_000,
    }));
  } catch (err) {
    // The runtime's own stderr, for the same reason discoverImage keeps it: a
    // socket the user cannot reach ("permission denied ... docker.sock", the
    // usual symptom of a rootless daemon or a sandbox) is a different problem
    // from a runtime that is not running, and Node's "Command failed" wrapper
    // hides which one it is behind the argv.
    const e = err as ExecError;
    const detail = (e.stderr ?? "").trim().split("\n")[0] || e.message.split("\n")[0];
    throw new Error(`${runtime} could not list running containers — ${detail}`);
  }
  const out: RunningContainer[] = [];
  for (const line of stdout.split("\n")) {
    const [rawNames = "", image = ""] = line.split("\t");
    const names = rawNames
      .replace(/^\[|\]$/g, "")
      .split(/[,\s]+/)
      .filter(Boolean);
    const first = names[0];
    if (!first) continue;
    out.push({ name: first, names, image: image.trim() });
  }
  return out;
}

/**
 * Running containers with no entry in the config.
 *
 * The container half's answer to `scan`, and it cannot be derived from the
 * image the way the brew path derives a formula from an update command: two
 * containers can run the same image, so the name is the only key.
 *
 * A container counts as tracked when ANY of its names is — the config records
 * whichever name was passed to `add --image`, and both resolve at the runtime.
 */
export async function untrackedContainers(
  trackedNames: Set<string>,
): Promise<{ runtime: string; running: number; untracked: RunningContainer[] }> {
  const runtime = await detectRuntime();
  const running = await runningContainers(runtime);
  return {
    runtime,
    running: running.length,
    untracked: running.filter((c) => !c.names.some((n) => trackedNames.has(n))),
  };
}

async function inspect(runtime: string, target: string, format: string): Promise<string> {
  const { stdout } = await run(runtime, ["inspect", "--format", format, target], {
    timeout: 30_000,
  });
  // Both runtimes print the Go template's empty value for a missing label
  // rather than failing, so "<no value>" has to be read as absence.
  const value = stdout.trim();
  return value === "<no value>" ? "" : value;
}

/**
 * Version of the running image.
 *
 * The label is preferred over the tag because a tag is a moving pointer —
 * `:latest` says nothing, and even `:2` says less than the label does. The tag
 * is the fallback, and only when it carries digits: "latest" or "stable" would
 * otherwise be recorded as a version and then compare as older than
 * everything, which reads as permanently up to date.
 */
export function versionFrom(label: string, imageRef: string): string {
  if (label.trim()) return label.trim();
  // A digest pin is not a version: `nginx@sha256:0a1b…` names one exact build,
  // and reading digits out of the digest yields "0" — which compares as older
  // than everything and renders as permanently up to date. Everything after
  // "@" is dropped before looking for a tag.
  const ref = imageRef.split("@")[0] ?? "";
  // The tag is what follows the last ":" only when that ":" comes after the
  // last "/" — before it, the colon is a registry port (registry.home:5000/app),
  // and "5000" as a version is newer than every release ever published.
  const colon = ref.lastIndexOf(":");
  const tag = colon > ref.lastIndexOf("/") ? ref.slice(colon + 1) : "";
  // The numeric part only, and for the same reason the generated regex takes
  // it: "17-alpine" would otherwise be shown here while every later run
  // reports "17", and a version that changes between `add` and the first
  // digest looks like a bug in whichever one you read second.
  const numeric = /[0-9][0-9.]*/.exec(tag)?.[0] ?? "";
  return numeric;
}

/**
 * The regex a no-label entry reads its version out of `{{.Config.Image}}`
 * with. The first ":" in a ref is not reliably the tag, so each piece guards
 * one wrong reading: the lazy `[^@\n]*?` prefix keeps the match out of a
 * digest (`app@sha256:0a…` must not probe as "0"), the `[^/:@\n]*` after the
 * number rejects a registry port (`registry.home:5000/app` has "/app" there,
 * so ":5000" cannot close) while carrying a decorated tag ("2.4-alpine")
 * through to the delimiter — the "@" of a pin, the end of the probe's line,
 * or the end of its output. Exported so the test can hold it against the same
 * ref shapes versionFrom is tested against.
 */
export const TAG_MATCH = "^[^@\\n]*?:v?([0-9][0-9.]*)[^/:@\\n]*(?:@|\\n|$)";

/**
 * Build a ready-to-use tool entry from a running container.
 *
 * Deliberately not batched, unlike the brew path. Two savings were measured
 * and both come to nothing here: detecting the runtime per container rather
 * than once costs 0.06s a call, and folding the three inspects below into one
 * tab-separated template saves two process starts per container — on a command
 * you run once per container, against a runtime this machine cannot currently
 * start to verify the template against. A batched `--format` would also have to
 * be trusted to keep empty fields in place, which is the kind of thing that
 * must be checked against the real podman and docker, not assumed.
 */
export async function discoverImage(container: string): Promise<ImageDiscovery> {
  const runtime = await detectRuntime();

  let image: string;
  try {
    image = await inspect(runtime, container, "{{.Config.Image}}");
  } catch (err) {
    // The runtime's own stderr, not Node's "Command failed" wrapper: "no such
    // object" and "cannot connect to the daemon" are entirely different
    // problems, and only the former is about the name you typed.
    const e = err as ExecError;
    const detail = (e.stderr ?? "").trim().split("\n")[0] || e.message.split("\n")[0];
    throw new Error(`${container}: ${runtime} could not inspect it — ${detail}`);
  }
  if (!image)
    throw new Error(
      `${container}: ${runtime} reports no image for it — a container built from a bare rootfs cannot be ` +
        "tracked by image; add it by hand with a source and an update command",
    );

  const [labelSource, labelVersion] = await Promise.all([
    inspect(runtime, container, `{{index .Config.Labels "${LABEL_SOURCE}"}}`),
    inspect(runtime, container, `{{index .Config.Labels "${LABEL_VERSION}"}}`),
  ]);

  // Reuses the brew path's URL parser: the label is a plain repo URL, which is
  // the same shape sourceFromUrls already resolves.
  //
  // A missing or unreadable label is not fatal, because roughly half of widely
  // used images carry no source label at all — postgres and nginx have none,
  // grafana only a maintainer address. Refusing outright would leave the user
  // to hand-write the fiddly part (the inspect argv and its regex) for the
  // commonest case. So the entry is still built, with `source` left blank for
  // a human to fill in.
  //
  // What it must not do is guess. ghcr.io/home-assistant/home-assistant is
  // built from github.com/home-assistant/core — deriving the repo from the
  // image path would land on a different, existing repo and quietly report
  // someone else's release notes.
  const source = labelSource ? (sourceFromUrls([labelSource]) ?? "") : "";
  const needsSource = source === "";

  const version = versionFrom(labelVersion, image);
  if (!version) {
    throw new Error(
      `${container}: neither ${LABEL_VERSION} nor the image tag ("${image}") carries a version number — ` +
        `bumpii would have nothing to compare against`,
    );
  }

  // The "installed version" of a container is a label on the image it runs,
  // not the output of a binary — but it is still a command producing a line
  // that a regex reads, so the existing version machinery carries it unchanged.
  const cmd = [runtime, "inspect", "--format", `{{index .Config.Labels "${LABEL_VERSION}"}}`, container];
  const match = labelVersion.trim() ? "v?([0-9][0-9.]*)" : null;

  return {
    container,
    image,
    version,
    source,
    runtime,
    needsSource,
    entry: {
      name: container,
      source,
      version: match
        ? { cmd, match }
        : // No version label: read the tag off the running container instead.
          {
            cmd: [runtime, "inspect", "--format", "{{.Config.Image}}", container],
            match: TAG_MATCH,
          },
      // Pulling is only half an update — the container still has to be
      // restarted onto the new image, and how depends on how it is run. Left
      // as something to complete rather than guessed at, since `--yes` would
      // execute it.
      update: `# complete this: pull ${image} and restart ${container}`,
    },
  };
}
