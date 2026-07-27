// SPDX-License-Identifier: GPL-3.0-or-later
// Turn raw release notes into structured items.
//
// Two engines, both optional at build time and discovered at run time:
//   - any OpenAI-compatible server (oMLX, Ollama, vLLM, LM Studio) via
//     OPENAI_BASE_URL — the local path, so notes never have to leave the machine
//   - the `claude` CLI, when it is on PATH
// No model is hardcoded or crowned: /v1/models is asked what it serves.
import { run } from "./exec.ts";
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

/**
 * Node's fetch reports every transport failure as a bare "fetch failed" and
 * puts the part you can act on — ECONNREFUSED, ENOTFOUND, a TLS complaint —
 * in `cause`. Unwrapping it is the difference between a message that names the
 * problem and one that only confirms there was one.
 */
function describeFetchError(err: unknown): string {
  const top = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const detail = cause instanceof Error ? cause.message : undefined;
  return detail && detail !== top ? `${top}: ${detail}` : top;
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

export function parseItems(text: string): DigestItem[] {
  // Models wrap JSON in fences often enough that stripping is cheaper than
  // re-prompting; find the outermost array rather than trusting the shape.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`no JSON array in engine output: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("engine output was not an array");

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
  if (!res.ok) throw new Error(`engine HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = body.choices?.[0]?.message?.content;
  if (!out) throw new Error("engine returned no content");
  return out;
}

async function askClaudeCli(engine: Engine, text: string): Promise<string> {
  const r = await run("claude", ["-p", "--model", engine.model, text], {
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return r.stdout;
}

/** Digest one tool's pending releases. Returns [] when no engine is available. */
export async function digest(engine: Engine, tool: string, releases: Release[]): Promise<DigestItem[]> {
  if (engine.kind === "none" || releases.length === 0) return [];
  const text = prompt(tool, releases);
  const out = engine.kind === "openai" ? await askOpenAi(engine, text) : await askClaudeCli(engine, text);
  return parseItems(out);
}
