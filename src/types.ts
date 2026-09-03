// SPDX-License-Identifier: GPL-3.0-or-later

/** One entry in the user's tool list. */
export interface ToolConfig {
  /** Display name and default binary name, e.g. "gh". */
  name: string;
  /**
   * "github:owner/repo", "codeberg:owner/repo", or "https://host/owner/repo".
   * May be empty for an entry `add --image` could not complete, which the
   * report then flags as needing one rather than treating as broken.
   */
  source: string;
  /**
   * The tag of a rolling release this tool follows instead of versioned
   * releases — ghostty's "tip", built fresh on every commit to main. The
   * release object under such a tag is mutable and its notes are boilerplate,
   * so what changed is read from the commit log between the installed build
   * and the tag. With a channel set, `version.match` must capture the commit
   * hash the installed build was made from, not a version number.
   */
  channel?: string;
  /** How to ask the installed binary for its version. */
  version: {
    /** argv, e.g. ["gh", "--version"]. Not a shell string — no quoting traps. */
    cmd: string[];
    /**
     * Regex with one capture group holding the bare version — or, for a
     * `channel` entry, the build's commit hash.
     */
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

/**
 * The four the engine is asked for, and the one it is not.
 *
 * `unclassified` is what a `kind` outside the other four becomes. It used to
 * become `fix` — the least alarming of them — so a model answering
 * "vulnerability" instead of "security" had its item filed under the heading
 * a reader skims past. That is a classification the run never made, which is
 * the one thing no report here is allowed to print.
 */
export type ItemKind = "security" | "breaking" | "unclassified" | "feature" | "fix";

/** One digested change, as the engine classified it. */
export interface DigestItem {
  kind: ItemKind;
  /** One line, imperative or descriptive — no marketing. */
  summary: string;
  /** Version this landed in. */
  version: string;
}

export interface ToolReport {
  tool: ToolConfig;
  installed: string | null;
  /**
   * Newest release carrying a comparable version, or null when the forge
   * published none. Null is emphatically not "up to date": a repo that only
   * tags, or tags "nightly", cannot be checked at all, and saying it is
   * current would be the one wrong answer an update checker must not give.
   */
  latest: string | null;
  /** Releases strictly newer than installed, oldest first. */
  behind: Release[];
  /**
   * Set for a rolling-channel entry. `behind` then holds at most one synthetic
   * release whose notes are the commit log, and `aheadBy` is the real distance
   * — the renderer says "N commits behind on tip" rather than "1 release
   * behind", which would be technically true and completely misleading.
   */
  channel?: { tag: string; aheadBy: number };
  /**
   * The forge had more releases than one page held and all of them were
   * pending, so `behind` is a floor rather than the count. Rendered as "30+".
   */
  truncated?: boolean;
  items: DigestItem[];
  /** Set when the tool could not be inspected; everything above is then empty. */
  error?: string;
  /**
   * Set when the engine failed on this tool's notes. Kept apart from `error`
   * on purpose: the releases were fetched successfully and are still worth
   * showing, so a model that returns junk costs you the summary, not the news.
   */
  digestError?: string;
}
