/**
 * `parseGitHubRepository` unit tests (G18-P2). Covers the three input
 * shapes the daemon sees in the wild: canonical owner/repo, HTTPS URL
 * (with and without `.git` + query/path tail), and SSH `git@…`.
 */

import { describe, expect, it } from "vitest";
import { parseGitHubRepository, splitNameWithOwner } from "../github";

describe("parseGitHubRepository", () => {
  it("parses canonical owner/repo", () => {
    expect(parseGitHubRepository("wavyrai/tmux-ide")).toEqual({
      owner: "wavyrai",
      repo: "tmux-ide",
      nameWithOwner: "wavyrai/tmux-ide",
      repositoryUrl: "https://github.com/wavyrai/tmux-ide",
    });
  });

  it("strips .git suffix from canonical input", () => {
    expect(parseGitHubRepository("wavyrai/tmux-ide.git")?.repo).toBe("tmux-ide");
  });

  it("parses HTTPS URL with optional .git and trailing path", () => {
    const a = parseGitHubRepository("https://github.com/foo/bar.git");
    const b = parseGitHubRepository("https://github.com/foo/bar/pull/42");
    const c = parseGitHubRepository("https://www.github.com/foo/bar?tab=readme");
    expect(a?.nameWithOwner).toBe("foo/bar");
    expect(b?.nameWithOwner).toBe("foo/bar");
    expect(c?.nameWithOwner).toBe("foo/bar");
  });

  it("parses SSH URL", () => {
    expect(parseGitHubRepository("git@github.com:foo/bar.git")?.nameWithOwner).toBe("foo/bar");
    expect(parseGitHubRepository("git@github.com:foo/bar")?.nameWithOwner).toBe("foo/bar");
  });

  it("returns null for inputs that aren't GitHub", () => {
    expect(parseGitHubRepository("")).toBeNull();
    expect(parseGitHubRepository(null)).toBeNull();
    expect(parseGitHubRepository("https://gitlab.com/foo/bar")).toBeNull();
    expect(parseGitHubRepository("not-a-url")).toBeNull();
  });
});

describe("splitNameWithOwner", () => {
  it("splits owner/repo into parts", () => {
    expect(splitNameWithOwner("wavyrai/tmux-ide")).toEqual({
      owner: "wavyrai",
      repo: "tmux-ide",
    });
  });

  it("throws on malformed input", () => {
    expect(() => splitNameWithOwner("invalid")).toThrowError(/expected "owner\/repo"/);
    expect(() => splitNameWithOwner("https://github.com/foo/bar")).toThrow();
  });
});
