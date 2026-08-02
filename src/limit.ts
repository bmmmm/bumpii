// SPDX-License-Identifier: GPL-3.0-or-later
// Cap how many async calls run at once — four lines, not a dependency.
//
// Built for judge(): digesting N tools with pending releases fires N calls at
// the resolved engine concurrently. A hosted API shrugs that off, but the
// OpenAI-compatible path this tool prefers (oMLX, Ollama, plain llama.cpp) is
// usually one model serving one request at a time — a stampede of concurrent
// calls there queues silently inside the server instead of in this process,
// and each one still counts against its own 180s timeout from the moment it
// was sent, not from when the server actually starts on it.

/** Returns a function that runs at most `max` of its given thunks at once. */
export function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];

  function pump(): void {
    if (active >= max) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job();
  }

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  };
}
