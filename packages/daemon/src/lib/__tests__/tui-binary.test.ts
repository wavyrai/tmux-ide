/**
 * Pure-helper tests for the per-platform TUI binary: platform mapping, bun
 * target flags, release asset names/URLs, and the version-stamped install path.
 * These are the load-bearing string contracts shared by the release workflow
 * (asset names) and the runtime downloader (URLs + paths) — a drift here ships a
 * binary the CLI can never find.
 */
import { describe, expect, it } from "vitest";
import {
  bunTargetForTag,
  downloadedTuiPath,
  normalizeVersion,
  releaseAssetName,
  releaseAssetUrl,
  tuiPlatformTag,
  type TuiPlatformTag,
} from "../tui-binary.ts";

const TAGS: TuiPlatformTag[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

describe("tuiPlatformTag — Node platform/arch → release tag", () => {
  it("maps each published platform", () => {
    expect(tuiPlatformTag("darwin", "arm64")).toBe("darwin-arm64");
    expect(tuiPlatformTag("darwin", "x64")).toBe("darwin-x64");
    expect(tuiPlatformTag("linux", "x64")).toBe("linux-x64");
    expect(tuiPlatformTag("linux", "arm64")).toBe("linux-arm64");
  });

  it("returns null for platforms we do not publish", () => {
    expect(tuiPlatformTag("win32", "x64")).toBeNull();
    expect(tuiPlatformTag("linux", "ia32")).toBeNull();
    expect(tuiPlatformTag("freebsd", "arm64")).toBeNull();
  });
});

describe("bunTargetForTag — the `bun build --compile --target` flag", () => {
  it("prefixes the tag with `bun-`", () => {
    expect(bunTargetForTag("darwin-arm64")).toBe("bun-darwin-arm64");
    expect(bunTargetForTag("linux-x64")).toBe("bun-linux-x64");
  });

  it("covers every tag with a distinct target", () => {
    const targets = TAGS.map(bunTargetForTag);
    expect(new Set(targets).size).toBe(TAGS.length);
    for (const t of targets) expect(t).toMatch(/^bun-(darwin|linux)-(arm64|x64)$/);
  });
});

describe("releaseAssetName — the uploaded/downloaded filename", () => {
  it("is `tmux-ide-tui-<tag>.gz`", () => {
    expect(releaseAssetName("darwin-arm64")).toBe("tmux-ide-tui-darwin-arm64.gz");
    expect(releaseAssetName("linux-arm64")).toBe("tmux-ide-tui-linux-arm64.gz");
  });
});

describe("normalizeVersion — tolerate a leading v", () => {
  it("strips exactly one leading v", () => {
    expect(normalizeVersion("2.6.1")).toBe("2.6.1");
    expect(normalizeVersion("v2.6.1")).toBe("2.6.1");
  });
});

describe("releaseAssetUrl — GitHub release download URL", () => {
  it("builds the wavyrai/tmux-ide download URL with a v-prefixed tag", () => {
    expect(releaseAssetUrl("2.6.1", "darwin-arm64")).toBe(
      "https://github.com/wavyrai/tmux-ide/releases/download/v2.6.1/tmux-ide-tui-darwin-arm64.gz",
    );
  });

  it("does not double the v when passed a v-prefixed version", () => {
    expect(releaseAssetUrl("v2.6.1", "linux-x64")).toBe(
      "https://github.com/wavyrai/tmux-ide/releases/download/v2.6.1/tmux-ide-tui-linux-x64.gz",
    );
  });
});

describe("downloadedTuiPath — version-stamped install location", () => {
  it("lives under <home>/bin and embeds tag + version", () => {
    expect(downloadedTuiPath("/home/me/.tmux-ide", "darwin-arm64", "2.6.1")).toBe(
      "/home/me/.tmux-ide/bin/tmux-ide-tui-darwin-arm64-2.6.1",
    );
  });

  it("normalizes a v-prefixed version so the path matches the running version", () => {
    expect(downloadedTuiPath("/h/.tmux-ide", "linux-x64", "v2.6.1")).toBe(
      "/h/.tmux-ide/bin/tmux-ide-tui-linux-x64-2.6.1",
    );
  });

  it("changes with the version (a new release misses the old download)", () => {
    const a = downloadedTuiPath("/h/.tmux-ide", "linux-x64", "2.6.1");
    const b = downloadedTuiPath("/h/.tmux-ide", "linux-x64", "2.7.0");
    expect(a).not.toBe(b);
  });
});
