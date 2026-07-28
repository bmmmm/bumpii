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

import { sourceFromUrls } from "./discover.ts";
import { type ExecError, run } from "./exec.ts";
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
  throw new Error("neither podman nor docker is on PATH — bumpii add --image needs one of them");
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
  const tag = imageRef.includes(":") ? (imageRef.split(":").pop() ?? "") : "";
  // The numeric part only, and for the same reason the generated regex takes
  // it: "17-alpine" would otherwise be shown here while every later run
  // reports "17", and a version that changes between `add` and the first
  // digest looks like a bug in whichever one you read second.
  const numeric = /[0-9][0-9.]*/.exec(tag)?.[0] ?? "";
  return numeric;
}

/** Build a ready-to-use tool entry from a running container. */
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
  if (!image) throw new Error(`${container}: ${runtime} reports no image for it`);

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
            match: ":v?([0-9][0-9.]*)",
          },
      // Pulling is only half an update — the container still has to be
      // restarted onto the new image, and how depends on how it is run. Left
      // as something to complete rather than guessed at, since `--yes` would
      // execute it.
      update: `# complete this: pull ${image} and restart ${container}`,
    },
  };
}
