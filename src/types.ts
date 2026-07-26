// SPDX-License-Identifier: GPL-3.0-or-later

/** One entry in the user's tool list. */
export interface ToolConfig {
  /** Display name and default binary name, e.g. "gh". */
  name: string;
  /** "github:owner/repo", "codeberg:owner/repo", or "https://host/owner/repo". */
  source: string;
  /** How to ask the installed binary for its version. */
  version: {
    /** argv, e.g. ["gh", "--version"]. Not a shell string — no quoting traps. */
    cmd: string[];
    /** Regex with one capture group holding the bare version. */
    match: string;
  };
  /** Shell command that upgrades it, e.g. "brew upgrade gh". */
  update: string;
}

export interface Config {
  /** Paths grepped to decide whether a change actually touches your usage. */
  usagePaths: string[];
  tools: ToolConfig[];
}

/** A release as the forge reports it. */
export interface Release {
  tag: string;
  /** Bare version, leading "v" stripped. */
  version: string;
  publishedAt: string | null;
  notes: string;
  url: string;
}

export type ItemKind = "security" | "breaking" | "feature" | "fix";

/**
 * One digested change. `commands` is what makes the relevance verdict
 * checkable: the model extracts which CLI surface a note talks about, and
 * usage.ts then greps for exactly those strings instead of the model being
 * asked to guess whether we care.
 */
export interface DigestItem {
  kind: ItemKind;
  /** One line, imperative or descriptive — no marketing. */
  summary: string;
  /** CLI surface this touches, e.g. ["gh attestation", "gh release verify"]. */
  commands: string[];
  /** Version this landed in. */
  version: string;
}

export interface UsageHit {
  command: string;
  file: string;
  line: number;
}

export interface ToolReport {
  tool: ToolConfig;
  installed: string | null;
  latest: string | null;
  /** Releases strictly newer than installed, oldest first. */
  behind: Release[];
  items: DigestItem[];
  /** Where the extracted commands actually appear in your own files. */
  hits: UsageHit[];
  /** Set when the tool could not be inspected; everything above is then empty. */
  error?: string;
}
