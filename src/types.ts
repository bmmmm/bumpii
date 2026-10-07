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

/**
 * Where an installed package's release notes live, said by hand — for the
 * packages whose brew metadata names no forge (a project that keeps a NEWS file), or
 * names one that publishes no releases. Keyed by brew name or tools.json name.
 * At least one field is set.
 */
export interface PackageMapping {
  /** Any form parseSource accepts. Wins over what brew's URLs derive. */
  source?: string;
  /**
   * A release-notes page, http(s). `{version}` in it is replaced by brew's
   * newest version, for projects that publish one page per release.
   */
  page?: string;
  /**
   * Why there is nothing to map: the project publishes no notes anywhere.
   * Turns a gap into an acknowledged one instead of hiding it.
   */
  none?: string;
}

export interface Config {
  /** Paths grepped to decide whether a change actually touches your usage. */
  usagePaths: string[];
  tools: ToolConfig[];
  /** Optional on disk; validate fills in `{}`. */
  packages?: Record<string, PackageMapping>;
}

/** A release as the forge reports it. */
export interface Release {
  tag: string;
  /** Bare version, leading "v" stripped. */
  version: string;
  publishedAt: string | null;
  notes: string;
  url: string;
  /**
   * Set only where prereleases were asked for (`notes` on an `@preview`
   * package); everywhere else prereleases are dropped before this exists.
   */
  prerelease?: boolean;
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

/** Notes omitted from a model request, separate from forge pagination. */
export interface DigestInput {
  totalCharacters: number;
  omittedCharacters: number;
  releases: { version: string; url: string; omittedCharacters: number }[];
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
  digestInput?: DigestInput;
}
