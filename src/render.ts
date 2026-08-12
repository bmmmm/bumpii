// SPDX-License-Identifier: GPL-3.0-or-later
import type { Inbox } from "./inbox.ts";
import type { Engine } from "./judge.ts";
import type { Overview, OverviewEntry } from "./overview.ts";
import type { ItemKind, ToolReport, UsageHit } from "./types.ts";

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

/**
 * An empty usagePaths config has to be said in every report that judges by
 * usage: with nothing to search, "affects you: none" and a zero reference
 * count are statements about an empty search, not about the user's files —
 * and unlike a missing path, nothing else in the report hints at it.
 */
function noUsagePathsWarning(consequence: string): string[] {
  return [
    yellow("no usagePaths configured"),
    dim(`  nothing was searched, so ${consequence}`),
    dim("  add usagePaths to the config so the verdict means something"),
    "",
  ];
}

export interface RenderOptions {
  engine: Engine;
  /** Configured usagePaths that do not exist — named, because they silently
   * turn every "affects you" verdict into "none". */
  missingPaths: string[];
  /** The config names no usagePaths at all — a different silence from
   * `missingPaths`, and one no other line of the report betrays. */
  noUsagePaths?: boolean;
  /**
   * Brew-outdated packages this digest never looked at, because nothing in
   * tools.json tracks them. `undefined` when the brew check itself failed or
   * did not run — that is silence, not a claim that nothing else is pending.
   */
  otherPending?: number;
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
      // Naming the channel is what keeps a commit hash readable as a version:
      // "b0b9fbc8d up to date" alone looks like a rendering slip.
      const on = r.channel ? ` on ${r.channel.tag}` : "";
      out.push(`${name} ${r.installed}  ${green(`up to date${on}`)}`, "");
      continue;
    }

    // A channel's `behind` is one synthetic release however far the gap is, so
    // its honest count is the commit distance — which the compare endpoint
    // reports exactly, even when the notes page ran out (no "+" needed).
    const behindLabel = r.channel
      ? `${r.channel.aheadBy} commit${r.channel.aheadBy === 1 ? "" : "s"} behind on ${r.channel.tag}`
      : // "30+" rather than "30" when the page ran out first: the count is what
        // a person acts on, and a silent cap makes a year-old install look
        // routine.
        `${r.behind.length}${r.truncated ? "+" : ""} release${r.behind.length === 1 ? "" : "s"} behind`;
    out.push(`${name} ${r.installed} → ${bold(r.latest)}  ${yellow(behindLabel)}`);

    if (r.items.length === 0) {
      out.push(dim(`  ${noDigestReason(r.digestError, opts.engine)}; raw notes:`));
      for (const rel of r.behind) out.push(dim(`    ${rel.version}  ${link(rel.url, rel.url)}`));
      if (r.mechanical) out.push(...mechanicalHits(r.hits, "  "));
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

  if (opts.noUsagePaths) {
    out.push(...noUsagePathsWarning('every "affects you" above answered an empty question'));
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
  if (opts.otherPending) {
    const plural = opts.otherPending === 1;
    out.push(
      dim(
        `${opts.otherPending} other package${plural ? "" : "s"} ${plural ? "has" : "have"} brew updates pending — bumpii overview, or brew upgrade`,
      ),
    );
  }
  out.push(dim(`engine: ${opts.engine.label}`), "");
  return out.join("\n");
}

/**
 * Commands found in the notes that also appear in your files, with no engine
 * behind the finding.
 *
 * Worded as "mentions", never as "affects you": nothing here knows which change
 * a string belongs to, or whether the note was announcing a fix or a heading.
 * What it does know is checkable — the string is in the notes and in that file —
 * and saying exactly that much is what separates it from a guess.
 */
function mechanicalHits(hits: UsageHit[], indent: string): string[] {
  if (hits.length === 0) return [];
  const byCommand = new Map<string, Set<string>>();
  for (const h of hits) {
    let files = byCommand.get(h.command);
    if (!files) {
      files = new Set();
      byCommand.set(h.command, files);
    }
    files.add(h.file);
  }
  const out: string[] = [
    `${indent}${yellow("mentions commands you call")}${dim(", though nothing judged which change:")}`,
  ];
  for (const [command, files] of byCommand) {
    const shown = [...files].slice(0, 2).join(", ");
    const more = files.size > 2 ? dim(` +${files.size - 2} more`) : "";
    out.push(`${indent}  ${command}${dim(" — ")}${shown}${more}`);
  }
  return out;
}

export function renderInbox(inbox: Inbox): string {
  const out: string[] = [""];

  if (inbox.entries.length === 0) {
    out.push(
      `${green("no unread release notifications")}  ${dim("GitHub queued nothing new from the repos you watch")}`,
      "",
    );
  }

  for (const e of inbox.entries) {
    const name = bold(e.repo);
    if (e.error) {
      // Its threads stay unread under --mark-read: nothing was shown, so the
      // notification is still the only reminder this release exists.
      out.push(`${name}  ${red("could not read its releases")}: ${e.error}`, "");
      continue;
    }
    const latest = e.releases.at(-1);
    const count = dim(`${e.releases.length} release${e.releases.length === 1 ? "" : "s"}`);
    const flags = [
      // brew would filter these; a subscription is you saying you want them.
      e.prerelease ? yellow("prerelease") : "",
      e.tracked ? dim(`tracked as ${e.tool}`) : "",
    ].filter(Boolean);
    out.push(`${name} → ${bold(latest?.tag ?? "?")}  ${count}${flags.length ? `  ${flags.join("  ")}` : ""}`);

    if (e.items.length === 0) {
      out.push(dim(`  ${noDigestReason(e.digestError, inbox.engine)}; raw notes:`));
      for (const rel of e.releases) out.push(dim(`    ${rel.tag}  ${link(rel.url, rel.url)}`));
      if (e.mechanical) out.push(...mechanicalHits(e.hits, "  "));
      out.push("");
      continue;
    }

    const sorted = [...e.items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    for (const item of sorted) {
      const mark = paint(item.kind, MARK[item.kind]);
      // The version doubles as the link to the release it landed in — same
      // trade as the overview, and for the same reason: an entry three
      // releases deep must not become a screenful of URL lines.
      const rel = e.releases.find((r) => r.version === item.version || r.tag === item.version);
      const where = item.version ? dim(` (${rel ? link(rel.url, item.version) : item.version})`) : "";
      out.push(`  ${mark} ${paint(item.kind, item.kind.padEnd(8))} ${item.summary}${where}`);
      const own = e.hits.filter((h) => item.commands.includes(h.command));
      if (own.length > 0) {
        const files = [...new Set(own.map((h) => h.file))];
        const more = files.length > 3 ? dim(` +${files.length - 3} more`) : "";
        out.push(`      ${yellow("you use this")}: ${files.slice(0, 3).join(", ")}${more}`);
      }
    }
    const touching = sorted.filter((i) => e.hits.some((h) => i.commands.includes(h.command))).length;
    out.push(
      dim(
        touching === 0
          ? "  affects you: none of these touch commands you call"
          : `  affects you: ${touching} of ${sorted.length} changes touch commands you call`,
      ),
      "",
    );
  }

  // The rest of the inbox is named, never expanded: this command reads release
  // news, and "inbox zero" while issue threads pile up would be claiming more
  // than it checked.
  const otherCount = Object.values(inbox.other).reduce((a, b) => a + b, 0);
  if (otherCount > 0) {
    const parts = Object.entries(inbox.other)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `${n} ${type}`)
      .join(dim(" · "));
    out.push(
      dim(`${otherCount} other unread notification${otherCount === 1 ? "" : "s"} — ${parts} — `) +
        dim(link("https://github.com/notifications", "github.com/notifications")),
    );
  }
  if (inbox.capped) {
    out.push(dim("the first page of notifications was full — the queue holds more than this"));
  }

  if (inbox.noUsagePaths) {
    out.push(...noUsagePathsWarning('every "affects you" above answered an empty question'));
  }
  if (inbox.missingUsagePaths.length > 0) {
    out.push(
      `${yellow("usagePaths not found")}: ${inbox.missingUsagePaths.join(", ")}`,
      dim("  nothing was searched there, so every “affects you” above is incomplete"),
    );
  }
  out.push(dim(`engine: ${inbox.engine.label}`), "");
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
  // "5+ releases" when the forge's page ran out before the pending list did:
  // the count is the number a person acts on, and a silent cap makes a tool
  // thirty releases behind look routine.
  const count =
    e.behind.length > 0
      ? dim(`   ${e.behind.length}${e.truncated ? "+" : ""} release${e.behind.length === 1 ? "" : "s"}`)
      : "";
  return `${name} ${e.installed} → ${bold(e.latest)}${count}   ${refs}${flags.length ? `   ${flags.join(" ")}` : ""}`;
}

function renderEntry(e: OverviewEntry, engine: Engine, prefix: string, cont: string, out: string[]): void {
  out.push(`${prefix} ${entryHead(e)}`);
  const body = (s: string) => out.push(`${cont}    ${s}`);

  if (e.compare) body(dim(link(e.compare, e.compare)));

  if (e.bucket === "no-repo") {
    body(dim("no forge repo in its brew URLs — nothing to read, and bumpii will not guess one"));
    // The trimmed name, not the padded one: this is the line meant to be copied.
    body(dim(`name it yourself: bumpii add ${e.name.trim()} --source github:owner/repo`));
    return;
  }
  if (e.bucket === "unreachable") {
    body(`${red("could not read its releases")}: ${e.error ?? "unknown error"}`);
    return;
  }

  if (e.items.length === 0) {
    // Three different states read as an empty list, and only the middle one is
    // "nothing changed". A repo that publishes no versioned releases at all
    // cannot be compared — saying "no release notes between these versions"
    // there reports a silence as a finding.
    body(
      dim(
        e.published === 0
          ? `${e.source} publishes no versioned releases — bumpii cannot tell what changed, only that brew has a newer build`
          : e.behind.length === 0
            ? "brew has a newer build, but the forge published no release between these versions"
            : `${noDigestReason(e.error, engine)}; raw notes:`,
      ),
    );
    for (const rel of e.behind) body(dim(`  ${rel.version}  ${link(rel.url, rel.url)}`));
    if (e.mechanical) for (const line of mechanicalHits(e.hits, "")) body(line);
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
    // With --only active, "anything installed" would claim more than was
    // answered: brew may have plenty pending that the filter excluded, and the
    // count says so instead of letting a clean slice read as a clean machine.
    out.push(
      o.filteredOut > 0
        ? `${green("nothing outdated among what --only names")}  ${dim(
            `brew has ${o.filteredOut} package${o.filteredOut === 1 ? "" : "s"} pending outside that filter — run without --only to see them`,
          )}`
        : `${green("nothing outdated")}  ${dim("brew has no newer version for anything installed")}`,
      "",
    );
  }

  section("★ digested", of("digested"), o.engine, out);
  // Its own heading, because these were not digested. The body says which of
  // the reasons applied; a shared "★ digested" heading over an entry reading
  // "digest failed" would be the report contradicting itself.
  section("★ pending, not digested", of("undigested"), o.engine, out);
  section("referenced, but bumpii found no repo to read", of("no-repo"), o.engine, out);
  section("referenced, but its forge could not be read", of("unreachable"), o.engine, out);

  if (o.current.length > 0) {
    // "tracked", not "referenced": every entry here was checked and is current,
    // but plenty of them are named in no file of yours, and calling those
    // referenced would assert the opposite of what the ref count says.
    out.push(bold("tracked, up to date"));
    out.push(`  ${o.current.map((t) => `${t.name} ${t.installed}`).join(dim(" · "))}`, "");
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

  // The two reasons brew stayed silent are different problems with different
  // answers, so they do not share a line.
  const notBrew = o.unchecked.filter((t) => t.reason === "not-brew");
  const notInstalled = o.unchecked.filter((t) => t.reason === "not-installed");
  if (notBrew.length > 0) {
    out.push(
      bold("tracked, not covered here"),
      `  ${notBrew.map((t) => t.name).join(dim(" · "))}`,
      dim("  brew does not manage these — run bumpii to check them"),
      "",
    );
  }
  if (notInstalled.length > 0) {
    out.push(
      bold("tracked, not installed"),
      `  ${notInstalled.map((t) => t.name).join(dim(" · "))}`,
      dim("  brew manages these but does not have them — nothing was checked, and nothing is up to date"),
      "",
    );
  }

  if (o.noUsagePaths) {
    out.push(...noUsagePathsWarning("every reference count is zero and the buckets above mean nothing"));
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

  const untrackedJudged = of("digested").filter((e) => !e.tracked);
  if (o.entries.length > 0) {
    // Every bucket, so the parts add up to the whole. The two that mean
    // "bumpii could not check" were the ones missing, which is exactly
    // backwards: an unread forge is the number worth seeing.
    const parts = [
      `${of("digested").length} digested`,
      of("undigested").length > 0 ? `${of("undigested").length} not digested` : "",
      of("no-repo").length > 0 ? `${of("no-repo").length} no repo` : "",
      of("unreachable").length > 0 ? `${of("unreachable").length} unreadable` : "",
      `${quiet.length} unreferenced`,
    ].filter(Boolean);
    out.push(dim(`${o.entries.length} pending — ${parts.join(" · ")}`));
    if (o.current.length > 0 || o.unchecked.length > 0) {
      out.push(
        dim(
          `${o.current.length} tracked and current` +
            `${o.unchecked.length > 0 ? ` · ${o.unchecked.length} tracked but unchecked` : ""}`,
        ),
      );
    }
  }
  if (untrackedJudged.length > 0) {
    out.push(dim(`  worth tracking: bumpii add ${untrackedJudged.map((e) => e.name.trim()).join(" ")}`));
  }
  out.push(dim(`engine: ${o.engine.label}`), "");
  return out.join("\n");
}
