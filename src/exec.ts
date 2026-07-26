// SPDX-License-Identifier: GPL-3.0-or-later
// One execFile wrapper for the whole tool, for one reason beyond deduplication:
// it closes the child's stdin immediately.
//
// bumpii runs binaries it did not choose — every formula the user tracks, and
// during `add` every binary a formula installs, some of them with no arguments
// at all (the last entry in discover.ts's PROBES). A CLI invoked bare is quite
// often a REPL, and an inherited open stdin pipe keeps it alive until the
// timeout fires. Closing stdin makes it read EOF and exit at once.
import { execFile, type ExecFileOptions } from "node:child_process";

export interface ExecOutput {
  stdout: string;
  stderr: string;
}

/** What a failed run rejects with: an Error carrying whatever it managed to print. */
export interface ExecError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

export function run(
  file: string,
  args: string[],
  opts: ExecFileOptions = {},
): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    // Explicit encoding, though utf8 is the default: it is what picks the
    // overload whose callback hands back strings rather than Buffers.
    const child = execFile(file, args, { ...opts, encoding: "utf8" as const }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      const e = err as ExecError;
      // execFile's own error drops the output; the callers need it, because a
      // non-zero exit can still have printed the version they were after.
      e.stdout = stdout;
      e.stderr = stderr;
      reject(e);
    });
    child.stdin?.end();
  });
}
