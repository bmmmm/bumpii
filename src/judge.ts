// SPDX-License-Identifier: GPL-3.0-or-later
// Turn raw release notes into structured items.
//
// Two engines, both optional at build time and discovered at run time:
//   - any OpenAI-compatible server (oMLX, Ollama, vLLM, LM Studio) via
//     OPENAI_BASE_URL — the local path, so notes never have to leave the machine
//   - the `claude` CLI, when it is on PATH
// No model is hardcoded or crowned: /v1/models is asked what it serves.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DigestItem, ItemKind, Release } from "./types.ts";

const run = promisify(execFile);

export type EngineKind = "openai" | "claude-cli" | "none";

export interface Engine {
  kind: EngineKind;
  model: string;
  /** Human-readable, for the report footer: you should always know who judged. */
  label: string;
}

const KINDS: ItemKind[] = ["security", "breaking", "feature", "fix"];

/** Ask an OpenAI-compatible server what it serves; first model wins. */
async function discoverOpenAiModel(base: string): Promise<string | null> {
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "local"}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string }[] };
    return body.data?.find((m) => m.id)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Pick an engine. Explicit --model wins; otherwise a local OpenAI-compatible
 * server is preferred over the hosted CLI, so the default keeps release notes
 * on the machine.
 */
export async function resolveEngine(opts: { model?: string } = {}): Promise<Engine> {
  const base = process.env.OPENAI_BASE_URL;
  if (base) {
    const model = opts.model ?? (await discoverOpenAiModel(base));
    if (model) return { kind: "openai", model, label: `openai-compatible/${model} @ ${base}` };
  }
  try {
    await run("claude", ["--version"], { timeout: 8000 });
    const model = opts.model ?? "haiku";
    return { kind: "claude-cli", model, label: `claude-cli/${model}` };
  } catch {
    // fall through
  }
  return { kind: "none", model: "", label: "none (no engine reachable)" };
}

function prompt(tool: string, releases: Release[]): string {
  const body = releases
    .map((r) => `### ${tool} ${r.version}\n${r.notes.slice(0, 12_000)}`)
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

function parseItems(text: string): DigestItem[] {
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
