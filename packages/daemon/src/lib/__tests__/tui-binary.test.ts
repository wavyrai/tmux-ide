/**
 * Per-platform TUI binary tests: pure release naming/path contracts plus the
 * bounded, integrity-checked downloader and its local cache recovery behavior.
 * These contracts are shared by the release workflow and runtime downloader —
 * drift here ships a binary the CLI can never safely select.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bunTargetForTag,
  downloadTuiBinary,
  downloadedTuiPath,
  findDownloadedTui,
  normalizeVersion,
  releaseAssetChecksumName,
  releaseAssetChecksumUrl,
  releaseAssetName,
  releaseAssetUrl,
  tuiPlatformTag,
  type TuiPlatformTag,
} from "../tui-binary.ts";

const TAGS: TuiPlatformTag[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const VERSION = "2.9.0-beta.1";
const TAG: TuiPlatformTag = "linux-x64";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TEST_LIMITS = {
  minBinaryBytes: 16,
  maxCompressedBytes: 4 * 1024,
  maxBinaryBytes: 4 * 1024,
};
const homes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tmux-ide-tui-binary-"));
  homes.push(home);
  return home;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseFixture(binary = Buffer.from("verified executable bytes")): {
  readonly binary: Buffer;
  readonly compressed: Buffer;
  readonly manifest: Buffer;
} {
  const compressed = gzipSync(binary);
  const asset = releaseAssetName(TAG);
  const manifest = Buffer.from(
    [
      `${digest(compressed)}  ${asset}`,
      `${digest(binary)}  ${asset.slice(0, -3)}`,
      `version ${VERSION}`,
      `platform ${TAG}`,
      `commit ${COMMIT}`,
      "",
    ].join("\n"),
  );
  return { binary, compressed, manifest };
}

function fixtureFetch(fixture: ReturnType<typeof releaseFixture>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(".sha256")) return new Response(fixture.manifest);
    if (url.endsWith(".gz")) return new Response(fixture.compressed);
    return new Response(null, { status: 404 });
  });
}

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

  it("publishes a SHA-256 sidecar beside every gzip asset", () => {
    expect(releaseAssetChecksumName("linux-x64")).toBe("tmux-ide-tui-linux-x64.gz.sha256");
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

  it("builds the matching exact-version checksum URL", () => {
    expect(releaseAssetChecksumUrl("v2.6.1", "linux-x64")).toBe(
      "https://github.com/wavyrai/tmux-ide/releases/download/v2.6.1/tmux-ide-tui-linux-x64.gz.sha256",
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

describe("downloadTuiBinary — bounded, verified, recoverable installation", () => {
  it("verifies the release manifest and atomically installs an executable cache", async () => {
    const home = scratchHome();
    const fixture = releaseFixture();
    const fetch = fixtureFetch(fixture);

    const installed = await downloadTuiBinary({
      version: VERSION,
      home,
      tag: TAG,
      fetch,
      limits: TEST_LIMITS,
    });

    expect(readFileSync(installed.path)).toEqual(fixture.binary);
    expect(readFileSync(`${installed.path}.sha256`)).toEqual(fixture.manifest);
    expect(findDownloadedTui(VERSION, { home, tag: TAG, limits: TEST_LIMITS })).toBe(
      installed.path,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a compressed SHA-256 mismatch without leaving a cache entry", async () => {
    const home = scratchHome();
    const fixture = releaseFixture();
    const corrupt = { ...fixture, compressed: Buffer.from(fixture.compressed) };
    corrupt.compressed[corrupt.compressed.length - 1] ^= 1;
    const path = downloadedTuiPath(home, TAG, VERSION);

    await expect(
      downloadTuiBinary({
        version: VERSION,
        home,
        tag: TAG,
        fetch: fixtureFetch(corrupt),
        limits: TEST_LIMITS,
      }),
    ).rejects.toThrow(/SHA-256 mismatch/u);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.sha256`)).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("rejects a manifest bound to another version", async () => {
    const home = scratchHome();
    const fixture = releaseFixture();
    const wrongVersion = {
      ...fixture,
      manifest: Buffer.from(
        fixture.manifest.toString().replace(`version ${VERSION}`, "version 9.9.9"),
      ),
    };
    await expect(
      downloadTuiBinary({
        version: VERSION,
        home,
        tag: TAG,
        fetch: fixtureFetch(wrongVersion),
        limits: TEST_LIMITS,
      }),
    ).rejects.toThrow(/manifest version mismatch/u);
  });

  it("verifies the decompressed executable hash before installation", async () => {
    const home = scratchHome();
    const fixture = releaseFixture();
    const wrongBinaryHash = {
      ...fixture,
      manifest: Buffer.from(
        fixture.manifest.toString().replace(digest(fixture.binary), "0".repeat(64)),
      ),
    };
    await expect(
      downloadTuiBinary({
        version: VERSION,
        home,
        tag: TAG,
        fetch: fixtureFetch(wrongBinaryHash),
        limits: TEST_LIMITS,
      }),
    ).rejects.toThrow(
      new RegExp(`SHA-256 mismatch for ${releaseAssetName(TAG).slice(0, -3)}`, "u"),
    );
  });

  it("rejects oversized compressed and decompressed responses", async () => {
    const home = scratchHome();
    const fixture = releaseFixture(Buffer.alloc(64, 1));
    const oversizedFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith(".sha256")) return new Response(fixture.manifest);
      return new Response(Buffer.alloc(4097));
    });
    await expect(
      downloadTuiBinary({
        version: VERSION,
        home,
        tag: TAG,
        fetch: oversizedFetch,
        limits: TEST_LIMITS,
      }),
    ).rejects.toThrow(/download exceeds 4096 bytes/u);

    await expect(
      downloadTuiBinary({
        version: VERSION,
        home,
        tag: TAG,
        fetch: fixtureFetch(fixture),
        limits: { ...TEST_LIMITS, maxBinaryBytes: 32 },
      }),
    ).rejects.toThrow(/could not safely decompress/u);
  });

  it("aborts a stalled fetch at the configured timeout", async () => {
    const home = scratchHome();
    const stalledFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );

    await expect(
      downloadTuiBinary({
        version: VERSION,
        home,
        tag: TAG,
        fetch: stalledFetch,
        timeoutMs: 10,
        limits: TEST_LIMITS,
      }),
    ).rejects.toThrow(/timed out after 10ms/u);
  });

  it("purges corrupt or non-executable caches so a later download can recover", async () => {
    const home = scratchHome();
    const fixture = releaseFixture();
    const fetch = fixtureFetch(fixture);
    const installed = await downloadTuiBinary({
      version: VERSION,
      home,
      tag: TAG,
      fetch,
      limits: TEST_LIMITS,
    });
    chmodSync(installed.path, 0o644);

    expect(findDownloadedTui(VERSION, { home, tag: TAG, limits: TEST_LIMITS })).toBeNull();
    expect(existsSync(installed.path)).toBe(false);
    const recovered = await downloadTuiBinary({
      version: VERSION,
      home,
      tag: TAG,
      fetch,
      limits: TEST_LIMITS,
    });
    writeFileSync(recovered.path, Buffer.alloc(fixture.binary.length, 0));
    chmodSync(recovered.path, 0o755);
    expect(findDownloadedTui(VERSION, { home, tag: TAG, limits: TEST_LIMITS })).toBeNull();
    expect(existsSync(recovered.path)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("serializes concurrent installers and reuses the verified winner", async () => {
    const home = scratchHome();
    const fixture = releaseFixture();
    const fetch = fixtureFetch(fixture);
    const options = {
      version: VERSION,
      home,
      tag: TAG,
      fetch,
      limits: TEST_LIMITS,
    } as const;

    const [first, second] = await Promise.all([
      downloadTuiBinary(options),
      downloadTuiBinary(options),
    ]);
    expect(first).toEqual(second);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
