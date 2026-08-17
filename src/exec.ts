// SPDX-License-Identifier: GPL-3.0-or-later
// One execFile wrapper for the whole tool, for one reason beyond deduplication:
// it closes the child's stdin immediately.
//
// bumpii runs binaries it did not choose — every formula the user tracks, and
// during `add` every binary a formula installs, some of them with no arguments
// at all (the last entry in discover.ts's PROBES). A CLI invoked bare is quite
// often a REPL, and an inherited open stdin pipe keeps it alive until the
// timeout fires. Closing stdin makes it read EOF and exit at once.
import { type ChildProcess, type ExecFileOptions, execFile } from "node:child_process";

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

/**
 * Node kills a child whose output exceeds maxBuffer, and its 1 MiB default is
 * a size real commands here outgrow with the machine: `brew info --json=v2
 * --installed` measured 827 KB for 178 formulae, so ~215 formulae would have
 * turned `scan --new` into "brew info --installed failed: stdout maxBuffer
 * length exceeded" — an error that blames brew for a limit set here. 32 MiB
 * is the ceiling usage.ts already chose for grep, allocated only as output
 * actually arrives; a caller with a reason can still override it.
 */
const MAX_OUTPUT = 32 * 1024 * 1024;

/**
 * Every child still running, so a signal can take them with it.
 *
 * Killing the parent does not kill these. Measured: SIGINT to the process
 * left its `sleep` child running and reparented. The commands here are not
 * cheap ones to strand — a judge is a `claude` invocation that may have
 * minutes of work left, and `--yes` runs `brew upgrade`, which was still
 * compiling. A terminal's Ctrl-C does signal the whole foreground group, so
 * the interactive case usually survives by luck; nothing about a SIGTERM, a
 * process supervisor or a parent that is not a terminal does.
 */
const running = new Set<ChildProcess>();

/**
 * Signal every child still running. Does not wait for them: this is called
 * from a signal handler on its way to process.exit, and a child that ignores
 * the signal would otherwise hold the terminal for as long as it liked.
 */
export function killChildren(signal: NodeJS.Signals = "SIGTERM"): number {
  let sent = 0;
  for (const c of running) {
    // Already-dead children are a no-op rather than an error, and `killed`
    // only says a signal was sent before, not that it worked.
    if (c.kill(signal)) sent++;
  }
  return sent;
}

export function run(file: string, args: string[], opts: ExecFileOptions = {}): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    // Explicit encoding, though utf8 is the default: it is what picks the
    // overload whose callback hands back strings rather than Buffers.
    const child = execFile(
      file,
      args,
      { maxBuffer: MAX_OUTPUT, ...opts, encoding: "utf8" as const },
      (err, stdout, stderr) => {
        running.delete(child);
        if (!err) return resolve({ stdout, stderr });
        const e = err as ExecError;
        // execFile's own error drops the output; the callers need it, because a
        // non-zero exit can still have printed the version they were after.
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
      },
    );
    running.add(child);
    child.stdin?.end();
  });
}

/**
 * Strip ANSI SGR sequences from output before matching against it. Some CLIs
 * colour their version even when stdout is not a TTY (`tea --version` prints
 * the number in bold), and those bytes would otherwise have to appear verbatim
 * in every `version.match` regex — working today and breaking the moment the
 * tool stops colouring, in a way that reads as "not installed".
 *
 * Here rather than in version.ts because it belongs to whatever produced the
 * output, not to one thing read out of it: `discover.ts` needs it for probe
 * lines that carry no version at all.
 */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point — this matches the escape byte a CLI actually emits.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
