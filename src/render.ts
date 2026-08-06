// SPDX-License-Identifier: GPL-3.0-or-later
import type { Engine } from "./judge.ts";
import type { Overview, OverviewEntry } from "./overview.ts";
import type { ItemKind, ToolReport } from "./types.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const red = (s: string) => c("31", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);

/**
 * A clickable link, where the terminal supports one (OSC 8).
 *
 * Gated on the same condition as colour, and never the only place the URL
 * appears: every link rendered here also has its target printed in full on the
 * line below. A terminal that does not speak OSC 8 drops the escape and shows
 * the text; one that does gets both. Piped output has neither, which is what
 * makes `bumpii overview | grep https` work at all.
 */
const link = (url: string, text: string) => (useColor ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text);

const MARK: Record<ItemKind, string> = {
  security: "!",
  breaking: "^",
  feature: "+",
  fix: "·",
};

function paint(kind: ItemKind, s: string): string {
  if (kind === "security") return red(s);
  if (kind === "breaking") return yellow(s);
  return s;
}

/** security first, then breaking, then features, then fixes. */
const ORDER: ItemKind[] = ["security", "breaking", "feature", "fix"];

export interface RenderOptions {
  engine: Engine;
  /** Configured usagePaths that do not exist — named, because they silently
   * turn every "affects you" verdict into "none". */
  missingPaths: string[];
}

/**
 * Why a tool has releases pending but no digested items. All three read as an
 * empty list, and telling the user "engine unavailable" when the engine
 * answered — or answered badly — sends them to fix the wrong thing.
 */
function noDigestReason(digestError: string | undefined, engine: Engine): string {
  if (digestError) return `digest failed: ${digestError}`;
  // The label carries why there is no engine — "skipped (--no-judge)" when you
  // turned it off yourself, which is not something to report as unavailable.
  if (engine.kind === "none") return `no digest — ${engine.label}`;
  return "engine returned nothing usable";
}

export function renderReport(reports: ToolReport[], opts: RenderOptions): string {
  const out: string[] = [""];

  for (const r of reports) {
    const name = bold(r.tool.name);

    // Missing on purpose rather than broken: `add --image` writes these when
    // an image does not name its repo. Everything else about the entry is
    // ready, so this is one line away from working — an error colour would
    // overstate it, and silence would lose it.
    if (!r.tool.source) {
      out.push(
        `${name}  ${yellow("needs a source")}  ${dim("its image did not say which repo it was built from")}`,
        dim(
          `  set "source" for ${r.tool.name} to e.g. github:owner/repo — nothing is being watched until then`,
        ),
        "",
      );
      continue;
    }
    if (r.error) {
      out.push(`${name}  ${red("error")}  ${r.error}`, "");
      continue;
    }
    if (!r.installed) {
      // A bare "?" for the latest version reads as a rendering slip when it is
      // really a second finding: the entry is not installed AND its source has
      // nothing to compare against, so there is nothing behind it to come back
      // to. Saying so is what separates a dormant entry from a dead one.
      out.push(
        r.latest
          ? `${name}  ${dim("not installed")}  ${dim(`latest ${r.latest}`)}`
          : `${name}  ${dim("not installed")}  ${dim(`and ${r.tool.source} publishes no versioned releases — nothing to install or watch`)}`,
        "",
      );
      continue;
    }
    // No comparable release means nothing was checked, which is a different
    // answer from "checked, nothing newer" — and must never wear its green.
    if (!r.latest) {
      out.push(
        `${name} ${r.installed}  ${yellow("unknown")}  ${dim(
          `${r.tool.source} publishes no versioned releases — bumpii cannot tell whether this is current`,
        )}`,
        dim("  it may tag without releasing; track it by hand or drop the entry"),
        "",
      );
      continue;
    }
    if (r.behind.length === 0) {
      out.push(`${name} ${r.installed}  ${green("up to date")}`, "");
      continue;
    }

    const plural = r.behind.length === 1 ? "release" : "releases";
    // "30+" rather than "30" when the page ran out first: the count is what a
    // person acts on, and a silent cap makes a year-old install look routine.
    const count = `${r.behind.length}${r.truncated ? "+" : ""}`;
    out.push(`${name} ${r.installed} → ${bold(r.latest)}  ${yellow(`${count} ${plural} behind`)}`);

    if (r.items.length === 0) {
      out.push(dim(`  ${noDigestReason(r.digestError, opts.engine)}; raw notes:`));
      for (const rel of r.behind) out.push(dim(`    ${rel.version}  ${rel.url}`));
      out.push(`  ${dim("→")} ${r.tool.update}`, "");
      continue;
    }

    const sorted = [...r.items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    for (const item of sorted) {
      const mark = paint(item.kind, MARK[item.kind]);
      const kindLabel = paint(item.kind, item.kind.padEnd(8));
      out.push(`  ${mark} ${kindLabel} ${item.summary}${item.version ? dim(` (${item.version})`) : ""}`);

      // The whole point: which of these you actually call.
      const own = r.hits.filter((h) => item.commands.includes(h.command));
      if (own.length > 0) {
        const files = [...new Set(own.map((h) => h.file))];
        const shown = files.slice(0, 3).join(", ");
        const more = files.length > 3 ? dim(` +${files.length - 3} more`) : "";
        out.push(`      ${yellow("you use this")}: ${shown}${more}`);
      }
    }

    // Count changes that touch your usage, not raw grep hits: "57 references"
    // is a number nobody can act on, "2 of 24 changes" is.
    const touching = sorted.filter((i) => r.hits.some((h) => i.commands.includes(h.command))).length;
    out.push(
      touching === 0
        ? dim(`  affects you: none of these touch commands you call`)
        : dim(`  affects you: ${touching} of ${sorted.length} changes touch commands you call`),
    );
    out.push(`  ${dim("→")} ${r.tool.update}`, "");
  }

  // Loud rather than dim: an unsearched path makes every "affects you" verdict
  // above meaningless, and it is the kind of typo that otherwise goes years.
  if (opts.missingPaths.length > 0) {
    out.push(
      `${yellow("usagePaths not found")}: ${opts.missingPaths.join(", ")}`,
      dim("  nothing was searched there, so every “affects you” above is incomplete"),
      dim("  correct it in usagePaths, or remove it, so the verdict means something again"),
      "",
    );
  }
  out.push(dim(`engine: ${opts.engine.label}`), "");
  return out.join("\n");
}

/** Tree connectors, so a section reads as one block rather than as loose lines. */
const BRANCH = { mid: "├─", last: "└─", pipe: "│ ", blank: "  " };

/** "gh   2.96.0 → 2.97.0   12 refs". The name arrives already padded. */
function entryHead(e: OverviewEntry): string {
  const name = bold(e.name);
  const refs = dim(`${e.refs} ref${e.refs === 1 ? "" : "s"}`);
  const flags = [
    e.tracked ? "" : dim("untracked"),
    e.kind === "cask" ? dim("cask") : "",
    // A pinned package is listed by brew as outdated but will not move until it
    // is unpinned — without saying so, its update line looks like it does
    // nothing.
    e.pinned ? yellow("pinned") : "",
  ].filter(Boolean);
  return `${name} ${e.installed} → ${bold(e.latest)}   ${refs}${flags.length ? `   ${flags.join(" ")}` : ""}`;
}

function renderEntry(e: OverviewEntry, engine: Engine, prefix: string, cont: string, out: string[]): void {
  out.push(`${prefix} ${entryHead(e)}`);
  const body = (s: string) => out.push(`${cont}    ${s}`);

  if (e.compare) body(dim(link(e.compare, e.compare)));

  if (e.bucket === "no-repo") {
    body(dim("no forge repo in its brew URLs — nothing to read, and bumpii will not guess one"));
    body(dim(`name it yourself: bumpii add ${e.name} --source github:owner/repo`));
    return;
  }
  if (e.bucket === "unreachable") {
    body(`${red("could not read its releases")}: ${e.error ?? "unknown error"}`);
    return;
  }

  if (e.items.length === 0) {
    // brew says newer while the forge published nothing between the two is a
    // real state (a revision bump, a tag never released) and not a digest
    // failure — everything else defers to the same reason the digest gives, so
    // "--no-judge" never reads as "the engine broke".
    body(
      dim(
        e.behind.length === 0
          ? "brew has a newer build, but the forge published no release notes between these versions"
          : `${noDigestReason(e.error, engine)}; raw notes:`,
      ),
    );
    for (const rel of e.behind) body(dim(`  ${rel.version}  ${link(rel.url, rel.url)}`));
    body(`${dim("→")} ${e.update}`);
    return;
  }

  const sorted = [...e.items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  for (const item of sorted) {
    const mark = paint(item.kind, MARK[item.kind]);
    // The version doubles as the link to the release it landed in, rather than
    // each item carrying a URL line of its own: a tool five releases behind
    // digests to twenty-odd items, and a line per URL turns one entry into a
    // screenful — which is the opposite of what an overview is for. The full
    // URL is still on screen once, on the compare line above.
    const rel = e.behind.find((r) => r.version === item.version);
    const where = item.version ? dim(` (${rel ? link(rel.url, item.version) : item.version})`) : "";
    body(`${mark} ${paint(item.kind, item.kind.padEnd(8))} ${item.summary}${where}`);
    const own = e.hits.filter((h) => item.commands.includes(h.command));
    if (own.length > 0) {
      const files = [...new Set(own.map((h) => h.file))];
      const more = files.length > 3 ? dim(` +${files.length - 3} more`) : "";
      body(`  ${yellow("you use this")}: ${files.slice(0, 3).join(", ")}${more}`);
    }
  }
  const touching = sorted.filter((i) => e.hits.some((h) => i.commands.includes(h.command))).length;
  body(
    dim(
      touching === 0
        ? "affects you: none of these touch commands you call"
        : `affects you: ${touching} of ${sorted.length} changes touch commands you call`,
    ),
  );
  body(`${dim("→")} ${e.update}`);
}

/** One block of entries under a heading, connected by tree characters. */
function section(title: string, entries: OverviewEntry[], engine: Engine, out: string[]): void {
  if (entries.length === 0) return;
  out.push(bold(title));
  const width = Math.max(...entries.map((e) => e.name.length));
  entries.forEach((e, i) => {
    const last = i === entries.length - 1;
    // Padding is applied here rather than in entryHead so every section lines
    // its own names up, instead of against the longest name in the report.
    const padded = { ...e, name: e.name.padEnd(width) };
    renderEntry(padded, engine, last ? BRANCH.last : BRANCH.mid, last ? BRANCH.blank : BRANCH.pipe, out);
  });
  out.push("");
}

export function renderOverview(o: Overview): string {
  const out: string[] = [""];
  const of = (b: OverviewEntry["bucket"]) => o.entries.filter((e) => e.bucket === b);

  // Nothing pending is a headline, not an early exit: the sections below say
  // what was checked to arrive at it, and which tracked entries brew could not
  // check at all. Returning here used to drop both, so the one run where the
  // answer is "all clear" was also the one that hid what "all" covered.
  if (o.entries.length === 0) {
    out.push(`${green("nothing outdated")}  ${dim("brew has no newer version for anything installed")}`, "");
  }

  section("★ digested", of("digested"), o.engine, out);
  section("referenced, but bumpii found no repo to read", of("no-repo"), o.engine, out);
  section("referenced, but its forge could not be read", of("unreachable"), o.engine, out);

  if (o.current.length > 0) {
    out.push(bold("referenced, up to date"));
    out.push(`  ${o.current.map((t) => `${t.name} ${t.installed || dim("?")}`).join(dim(" · "))}`, "");
  }

  const quiet = of("no-signal");
  if (quiet.length > 0) {
    // Deliberately unjudged, and the heading says why: with no file of yours
    // naming it, "does this change affect you" has nothing to be answered
    // against, and a model asked anyway would return an opinion.
    out.push(
      bold(`no signal (${quiet.length})`),
      dim("  no file in your usagePaths names these — version and link only"),
    );
    const width = Math.max(...quiet.map((e) => e.name.length));
    for (const e of quiet) {
      out.push(
        `  ${e.name.padEnd(width)}  ${e.installed} → ${e.latest}${e.pinned ? `  ${yellow("pinned")}` : ""}`,
      );
      if (e.source) {
        // Untracked and unreferenced, so no releases were fetched and no tags
        // are known — the repo itself is the only link that is certainly real.
        const repo = e.source.startsWith("github:")
          ? `https://github.com/${e.source.slice(7)}/releases`
          : e.source.startsWith("codeberg:")
            ? `https://codeberg.org/${e.source.slice(9)}/releases`
            : `${e.source.replace(/\/$/, "")}/releases`;
        out.push(`    ${dim(link(repo, repo))}`);
      }
    }
    out.push("");
  }

  if (o.unchecked.length > 0) {
    out.push(
      bold("tracked, not covered here"),
      `  ${o.unchecked.map((t) => t.name).join(dim(" · "))}`,
      dim("  brew does not manage these — run bumpii to check them"),
      "",
    );
  }

  if (o.missingUsagePaths.length > 0) {
    // Loud, and above the summary: with a path unsearched, every ref count in
    // the report is short, which is what decides the buckets — so this is not
    // a footnote, it is a warning that the sorting itself may be wrong.
    out.push(
      `${yellow("usagePaths not found")}: ${o.missingUsagePaths.join(", ")}`,
      dim(
        "  nothing was searched there, so the reference counts — and the buckets they sort into — are incomplete",
      ),
      "",
    );
  }

  const judged = of("digested").length;
  const untrackedJudged = of("digested").filter((e) => !e.tracked);
  if (o.entries.length > 0) {
    out.push(
      dim(
        `${o.entries.length} pending · ${judged} digested · ${quiet.length} unreferenced` +
          `${o.current.length > 0 ? ` · ${o.current.length} current` : ""}`,
      ),
    );
  }
  if (untrackedJudged.length > 0) {
    out.push(dim(`  worth tracking: bumpii add ${untrackedJudged.map((e) => e.name).join(" ")}`));
  }
  out.push(dim(`engine: ${o.engine.label}`), "");
  return out.join("\n");
}
