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
  source: string;
  entry: ToolConfig;
  /** Which runtime answered, so the generated entry can be sanity-checked. */
  runtime: string;
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
  return /[0-9]/.test(tag) ? tag : "";
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

  if (!labelSource) {
    throw new Error(
      `${container}: its image carries no ${LABEL_SOURCE} label, so there is no repo to read release notes from — ` +
        `add the entry by hand with a "source" of "github:owner/repo", or ask the image's author to set the label`,
    );
  }

  // Reuses the brew path's URL parser: the label is a plain repo URL, which is
  // the same shape sourceFromUrls already resolves.
  const source = sourceFromUrls([labelSource]);
  if (!source) {
    throw new Error(
      `${container}: ${LABEL_SOURCE} is "${labelSource}", which is not a forge URL bumpii can read — ` +
        `add the entry by hand with a "source" of "github:owner/repo" or a full forge URL`,
    );
  }

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
