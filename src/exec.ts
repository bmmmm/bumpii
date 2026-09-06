// SPDX-License-Identifier: GPL-3.0-or-later
// The two child-process wrappers for the whole tool — `run` buffers, `stream`
// hands the child the terminal — for one reason beyond deduplication: every
// child either starts is tracked so `killChildren()` can take it along, and
// neither ever gives a child an open stdin.
//
// bumpii runs binaries it did not choose — every formula the user tracks, and
// during `add` every binary a formula installs, some of them with no arguments
// at all (the last entry in discover.ts's PROBES). A CLI invoked bare is quite
// often a REPL, and an inherited open stdin pipe keeps it alive until the
// timeout fires. `run` closes stdin at once; `stream` opens it on /dev/null,
// which reads EOF the same way.
import {
  type ChildProcess,
  type ExecFileOptions,
  execFile,
  type SpawnOptions,
  spawn,
} from "node:child_process";

export interface ExecOutput {
  stdout: string;
  stderr: string;
}

/** What a failed run rejects with: an Error carrying whatever it managed to print. */
export interface ExecError extends Error {
  code?: number | string;
  /**
   * True when a signal reached the child — execFile's own timeout kill, or
   * ours from `killChildren()`. A maxBuffer kill builds its error before it
   * sends the signal and leaves this unset (measured).
   */
  killed?: boolean;
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
    const started = Date.now();
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
        // A timeout arrives as `killed: true, signal: "SIGTERM", code: null` and
        // a message that says only "Command failed" (measured) — which reads as
        // the command dying on its own, twenty minutes into a `brew upgrade`.
        // `killed` alone does not identify it: `killChildren()` sets the same
        // flag on its way to exit. The elapsed time does; a kill from outside
        // that lands at exactly the deadline is one the deadline was about to
        // deliver anyway. Prepended, never replaced: the callers wrap this
        // message and still need the original text after the colon.
        if (
          opts.timeout !== undefined &&
          opts.timeout > 0 &&
          e.killed &&
          Date.now() - started >= opts.timeout
        ) {
          e.message = `timed out after ${opts.timeout} ms: ${e.message}`;
        }
        reject(e);
      },
    );
    running.add(child);
    child.stdin?.end();
  });
}

/** How a streamed child ended: one of the two is set, as Node reports it. */
export interface StreamResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Run a command with the terminal: its stdout and stderr are the caller's own,
 * written by the child directly, so a `brew upgrade` shows its progress as it
 * happens instead of as one block when it returns. Nothing is captured, and
 * there is no timeout — this is the interactive path, and Ctrl-C reaches the
 * child through `killChildren()`.
 *
 * `stdio` is not a caller's option: passing "pipe" would silently defeat the
 * point. stdin is /dev/null, not a closed pipe as in `run`, and satisfies the
 * same REPL concern — EOF on the first read.
 *
 * Two listeners, and both are needed. A binary that is not there emits
 * `error` and then `close`, and never `exit` (measured), so an `exit`-only
 * version hangs forever on ENOENT; a child that ran to an exit code emits
 * `exit` and no `error`.
 */
export function stream(
  file: string,
  args: string[],
  opts: Omit<SpawnOptions, "stdio"> = {},
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...opts, stdio: ["ignore", "inherit", "inherit"] });
    running.add(child);
    child.once("error", (err) => {
      running.delete(child);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      running.delete(child);
      if (code === 0) return resolve({ code, signal });
      // Bare, so a caller can put its own "<name>: update failed:" in front.
      reject(new Error(signal ? `killed by ${signal}` : `exited ${code}`));
    });
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
