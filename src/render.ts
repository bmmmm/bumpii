// SPDX-License-Identifier: GPL-3.0-or-later
import type { ItemKind, ToolReport } from "./types.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const red = (s: string) => c("31", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);

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

export function renderReport(reports: ToolReport[], engineLabel: string): string {
  const out: string[] = [""];

  for (const r of reports) {
    const name = bold(r.tool.name);

    if (r.error) {
      out.push(`${name}  ${red("error")}  ${r.error}`, "");
      continue;
    }
    if (!r.installed) {
      out.push(`${name}  ${dim("not installed")}  ${dim(`latest ${r.latest ?? "?"}`)}`, "");
      continue;
    }
    if (r.behind.length === 0) {
      out.push(`${name} ${r.installed}  ${green("up to date")}`, "");
      continue;
    }

    const plural = r.behind.length === 1 ? "release" : "releases";
    out.push(
      `${name} ${r.installed} → ${bold(r.latest ?? "?")}  ${yellow(`${r.behind.length} ${plural} behind`)}`,
    );

    if (r.items.length === 0) {
      out.push(dim("  no digest — engine unavailable; raw notes:"));
      for (const rel of r.behind) out.push(dim(`    ${rel.version}  ${rel.url}`));
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

  out.push(dim(`engine: ${engineLabel}`), "");
  return out.join("\n");
}
