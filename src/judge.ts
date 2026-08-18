// SPDX-License-Identifier: GPL-3.0-or-later
// Turn raw release notes into structured items.
//
// Two engines, both optional at build time and discovered at run time:
//   - any OpenAI-compatible server (oMLX, Ollama, vLLM, LM Studio) via
//     OPENAI_BASE_URL — the local path, so notes never have to leave the machine
//   - the `claude` CLI, when it is on PATH
// No model is hardcoded or crowned: /v1/models is asked what it serves.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";
import { describeFetchError } from "./sources.ts";
import type { DigestItem, ItemKind, Release } from "./types.ts";

export type EngineKind = "openai" | "claude-cli" | "none";

export interface Engine {
  kind: EngineKind;
  model: string;
  /** Human-readable, for the report footer: you should always know who judged. */
  label: string;
}

const KINDS: ItemKind[] = ["security", "breaking", "feature", "fix"];

type EngineProbe = { reachable: true; models: string[] } | { reachable: false; reason: string };

/** Ask an OpenAI-compatible server what it serves — and whether it is there. */
async function probeOpenAi(base: string): Promise<EngineProbe> {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "local"}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { reachable: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return { reachable: true, models };
  } catch (err) {
    return { reachable: false, reason: describeFetchError(err) };
  }
}

/** Append why the preferred engine was not used, so the footer explains itself. */
function labelWith(label: string, note: string): string {
  return note ? `${label} — ${note}` : label;
}

/**
 * Pick an engine. A local OpenAI-compatible server is preferred over the
 * hosted CLI, so the default keeps release notes on the machine.
 *
 * The server is probed even when --model names one. Skipping the probe in that
 * case meant a dead OPENAI_BASE_URL was still reported as the engine, and
 * every tool then made its own doomed request — the same failure printed once
 * per tool, and up to a three-minute wait each where the socket hangs rather
 * than refuses. An explicit --model still wins over what /v1/models lists,
 * though: a server is allowed to serve more than it advertises.
 */
export async function resolveEngine(opts: { model?: string } = {}): Promise<Engine> {
  const base = process.env.OPENAI_BASE_URL;
  let note = "";
  if (base) {
    const probe = await probeOpenAi(base);
    if (probe.reachable) {
      const model = opts.model ?? probe.models[0];
      if (model) return { kind: "openai", model, label: `openai-compatible/${model} @ ${base}` };
      note = `OPENAI_BASE_URL serves no models`;
    } else {
      note = `OPENAI_BASE_URL unreachable (${probe.reason})`;
    }
  }
  try {
    await run("claude", ["--version"], { timeout: 8000 });
    const model = opts.model ?? "haiku";
    return { kind: "claude-cli", model, label: labelWith(`claude-cli/${model}`, note) };
  } catch {
    // fall through
  }
  return { kind: "none", model: "", label: labelWith("none (no engine reachable)", note) };
}

/**
 * Total release-note characters one digest may carry.
 *
 * A per-release cap alone is not one: a tool left alone for a year arrives
 * with thirty releases, and thirty times a generous cap is a prompt no local
 * 8k-context model can take — which is the path this tool prefers by default.
 * The budget is split across whatever came in, with a floor low enough to stay
 * useful and high enough to still describe a change.
 */
const PROMPT_BUDGET = 60_000;
const MIN_PER_RELEASE = 800;

function prompt(tool: string, releases: Release[]): string {
  const per = Math.max(MIN_PER_RELEASE, Math.floor(PROMPT_BUDGET / Math.max(1, releases.length)));
  const body = releases
    .map((r) => {
      const notes =
        r.notes.length > per
          ? `${r.notes.slice(0, per)}\n…[truncated at ${per} characters — see ${r.url}]`
          : r.notes;
      return `### ${tool} ${r.version}\n${notes}`;
    })
    .join("\n\n");
  return `You are summarising release notes for someone who uses the \`${tool}\` CLI daily and needs to know what is newly available or newly broken.

Return ONLY a JSON array, no prose, no code fence. Each element:
{"kind":"security|breaking|feature|fix","summary":"one line","commands":["<cli surface>"],"version":"<x.y.z>"}

Rules:
- Cover every user-visible change. Skip the project's own dependency bumps
  (e.g. "bump actions/checkout", "chore(deps)") — those are not usable by a
  consumer of the CLI.
- "commands" lists the CLI surface a change touches, as a user would type it,
  at the MOST SPECIFIC level the notes support: "gh pr view --json" beats
  "gh pr view", which beats "gh pr". A bare top-level group like "gh" or
  "gh pr" matches half the user's scripts and tells them nothing — leave
  "commands" empty rather than naming a group that broad. Use [] when a change
  is not tied to a specific command at all. These strings are grepped verbatim
  against the user's own scripts, so never invent flags the notes do not name.
- "summary" is one factual line. No marketing, no "improved experience".
- Prefer kind "security" for anything describing a vulnerability or CVE, and
  "breaking" for renamed/removed commands and changed defaults.

Release notes:

${body}`;
}

/**
 * Whether any of these releases carries something an engine could read.
 *
 * The one predicate behind three different claims, which is why it lives here
 * rather than beside any of them: {@link digest} drops empty bodies before it
 * builds a prompt, the renderers have to say so instead of blaming the engine
 * for a call that never happened, and `mechanical` must not claim a pass over
 * text that was not there. Answering it three times is how the three answers
 * drifted apart in the first place.
 */
export function hasReadableNotes(releases: Release[]): boolean {
  return releases.some((r) => r.notes.trim() !== "");
}

/**
 * Whether this entry's hits were read out of the notes with no engine involved.
 *
 * Requires notes to read. A release published with an empty body — htop tags
 * every version and writes nothing — offers nothing to extract, and saying the
 * mechanical read happened there describes a pass over no text. The `hits` come
 * out empty either way, so this decides what the entry claims rather than what
 * it shows.
 */
export function isMechanical(itemCount: number, behind: Release[]): boolean {
  return itemCount === 0 && hasReadableNotes(behind);
}

export function parseItems(text: string): DigestItem[] {
  // Models wrap JSON in fences often enough that stripping is cheaper than
  // re-prompting; find the outermost array rather than trusting the shape.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start)
    throw new Error(
      `no JSON array in engine output — the model answered in prose. Try a larger model with ` +
        `--model, or --no-judge to keep the release list without a summary: ${text.slice(0, 200)}`,
    );
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed))
    throw new Error(
      "engine output parsed as JSON but not as an array — try a larger model with --model, or --no-judge",
    );

  const items: DigestItem[] = [];
  for (const raw of parsed) {
    const o = raw as Record<string, unknown>;
    const kind = String(o.kind ?? "").toLowerCase() as ItemKind;
    const summary = typeof o.summary === "string" ? o.summary.trim() : "";
    if (!summary) continue;
    items.push({
      kind: KINDS.includes(kind) ? kind : "fix",
      summary,
      commands: Array.isArray(o.commands) ? o.commands.filter((c): c is string => typeof c === "string") : [],
      version: typeof o.version === "string" ? o.version : "",
    });
  }
  return items;
}

async function askOpenAi(engine: Engine, text: string): Promise<string> {
  const base = (process.env.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "local"}`,
    },
    body: JSON.stringify({
      model: engine.model,
      messages: [{ role: "user", content: text }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok)
    throw new Error(
      `engine HTTP ${res.status} from ${base}/chat/completions — check OPENAI_BASE_URL and that ` +
        `"${engine.model}" is one of the models it serves (/v1/models lists them): ${await res.text()}`,
    );
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = body.choices?.[0]?.message?.content;
  if (!out)
    throw new Error(
      `engine accepted the request but returned an empty message — "${engine.model}" may not be loaded; ` +
        "check /v1/models, or run with --no-judge",
    );
  return out;
}

async function askClaudeCli(engine: Engine, text: string): Promise<string> {
  // `--allowedTools ""` leaves the agent with none. The prompt is release-note
  // text written by whoever published the release, and summarising it needs no
  // tool at all — so the cheapest answer to "what could an injected note make
  // it do" is: nothing it has.
  //
  // The flag goes AFTER the prompt, and that is not a style choice: it takes a
  // variadic `<tools...>`, so with the prompt behind it the prompt is read as a
  // tool name and the call dies with "Input must be provided either through
  // stdin or as a prompt argument" — measured, before this ordering.
  const r = await run("claude", ["-p", text, "--model", engine.model, "--allowedTools", ""], {
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return r.stdout;
}

/**
 * Where judged release notes are kept between runs.
 *
 * Under the cache directory rather than beside tools.json, which is where the
 * resolved-source cache lives: that one is a single small table keyed on names
 * a person might recognise, this one grows by a file per tool per upgrade per
 * model and is pure derived data. Deleting the directory costs exactly one slow
 * run, which is also the way to force every judgement to be made again.
 */
export function digestCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "bumpii", "digests");
}

/**
 * The cache key for one judgement.
 *
 * Content-addressed over the whole prompt rather than over (tool, version):
 * the prompt already carries the tool, the versions and the notes, so editing
 * `prompt` or `PROMPT_BUDGET` retires every entry it would invalidate by
 * itself — there is no schema counter anyone has to remember to bump, and no
 * way for a reworded prompt to be answered from the old wording's cache.
 *
 * The engine is in the key because the answer is the model's, not the notes':
 * switching from haiku to a local model must produce that model's reading, not
 * a replay of the other one's.
 */
export function digestKey(engine: Engine, promptText: string): string {
  return createHash("sha256").update(`${engine.kind}\0${engine.model}\0${promptText}`).digest("hex");
}

/**
 * A stored judgement, or null when there is none.
 *
 * The raw engine output is what is stored, not the parsed items: parsing is
 * free next to the call that produced the text, and keeping the text means a
 * later fix to {@link parseItems} reaches everything already cached instead of
 * being shadowed by items parsed by the old rules.
 */
export async function readCachedDigest(key: string, dir = digestCacheDir()): Promise<string | null> {
  try {
    return await readFile(join(dir, `${key}.txt`), "utf8");
  } catch {
    // Same rule the source cache follows: a cache is the one file that must
    // never break a run, so an unreadable one is simply a miss.
    return null;
  }
}

export async function writeCachedDigest(key: string, raw: string, dir = digestCacheDir()): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${key}.txt`);
    // One file per key, published by rename. Three judges run at once
    // (JUDGE_CONCURRENCY), and a single shared JSON map would lose entries to
    // read-modify-write races between them — the failure mode being that the
    // slowest tool of each run is the only one whose judgement survives.
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, raw, "utf8");
    await rename(tmp, path);
  } catch {
    // Failing to persist costs a repeat judgement next run, nothing else.
  }
}

/**
 * Digest one tool's pending releases. Returns [] when no engine is available.
 *
 * Answered from cache when the same notes have already been judged by the same
 * model. This is where nearly all of a run's wall-clock goes — measured at 140s
 * for `overview` against 4s with `--no-judge`, one `claude -p` subprocess per
 * tool — and the notes for a published tag do not change, so a hit is not a
 * stale answer but the same answer without the wait.
 */
export async function digest(engine: Engine, tool: string, releases: Release[]): Promise<DigestItem[]> {
  if (engine.kind === "none" || releases.length === 0) return [];
  // A release with an empty body carries nothing to summarise, and plenty of
  // projects tag every version that way — htop publishes plain tags, so its
  // whole prompt was the line "### htop 3.5.3". A model handed that answers by
  // asking for the notes, in prose, which fails to parse and surfaces in the
  // report as "digest failed: the model answered in prose" — an engine problem
  // where there is none. Dropped before the prompt is built rather than after
  // the answer comes back, because the call could not have produced anything.
  const readable = releases.filter((r) => r.notes.trim() !== "");
  if (readable.length === 0) return [];
  const text = prompt(tool, readable);
  const key = digestKey(engine, text);

  const cached = await readCachedDigest(key);
  if (cached !== null) {
    try {
      return parseItems(cached);
    } catch {
      // A stored answer that no longer parses is treated as a miss rather than
      // as a failure: re-judging is always available, and refusing to would
      // make a tightened parser break runs that used to work.
    }
  }

  const out = engine.kind === "openai" ? await askOpenAi(engine, text) : await askClaudeCli(engine, text);
  const items = parseItems(out);
  // Stored only once it has parsed. Caching an answer that does not would pin
  // that failure for every future run, and the point of the key is that a hit
  // is always usable.
  await writeCachedDigest(key, out);
  return items;
}
