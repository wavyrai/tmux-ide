import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopUpdater } from "./desktop-updater.ts";
import { loopbackOrHttpsArtifactUrl } from "./update-manifest.ts";
import { unsignedFeedManifestVerifier } from "./update-verify.ts";
import { createUpdaterIo, readPendingMarker } from "./update-runtime.ts";

interface Feed {
  server: Server;
  origin: string;
}

/**
 * A local feed: `/desktop/stable.json` describes a release whose single artifact
 * lives at `/artifact.bin`. `serveBytes` is what the artifact endpoint actually
 * returns — pass the real bytes for the happy path, or different bytes to simulate
 * a corrupted/tampered download whose digest won't match the manifest.
 */
async function startFeed(input: {
  version: string;
  artifactBytes: Buffer;
  serveBytes: Buffer;
}): Promise<Feed> {
  const sha256 = createHash("sha256").update(input.artifactBytes).digest("hex");
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === "/desktop/stable.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          channel: "stable",
          version: input.version,
          artifacts: [
            {
              platform: "darwin-arm64",
              url: `${origin}/artifact.bin`,
              size: input.artifactBytes.byteLength,
              sha256,
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/artifact.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(input.serveBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function updaterAgainst(feed: Feed): Promise<{ updater: DesktopUpdater; stateDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), "tmux-ide-update-it-"));
  cleanups.push(async () => {
    await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
  });
  const io = createUpdaterIo({
    stateDir,
    net: { fetch: (url) => fetch(url) as unknown as ReturnType<typeof fetch> },
  });
  const updater = new DesktopUpdater({
    config: {
      enabled: true,
      feedBaseUrl: `${feed.origin}/desktop`,
      channel: "stable",
      platformKey: "darwin-arm64",
      currentVersion: "2.7.0",
      maxArtifactBytes: 10_000_000,
      checkIntervalMs: 1000,
      trustArtifactUrl: loopbackOrHttpsArtifactUrl,
    },
    io,
    verifier: unsignedFeedManifestVerifier(),
  });
  return { updater, stateDir };
}

describe("auto-update integration (local feed)", () => {
  it("reaches ready and stages a verified artifact end to end", async () => {
    const artifactBytes = randomBytes(4096);
    const feed = await startFeed({ version: "2.8.0", artifactBytes, serveBytes: artifactBytes });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => feed.server.close(() => resolve()));
    });

    const { updater, stateDir } = await updaterAgainst(feed);
    await updater.checkNow();

    expect(updater.status()).toEqual({
      phase: "ready",
      currentVersion: "2.7.0",
      availableVersion: "2.8.0",
    });
    const marker = await readPendingMarker(stateDir);
    expect(marker?.version).toBe("2.8.0");
    expect(marker).not.toBeNull();
    // The staged payload really exists on disk.
    await expect(stat(marker!.stagedPath)).resolves.toBeTruthy();
  });

  it("falls back clean when the served artifact is corrupted", async () => {
    const artifactBytes = randomBytes(4096);
    const feed = await startFeed({
      version: "2.8.0",
      artifactBytes,
      serveBytes: randomBytes(4096), // wrong bytes → digest mismatch
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => feed.server.close(() => resolve()));
    });

    const { updater, stateDir } = await updaterAgainst(feed);
    await updater.checkNow();

    expect(updater.status().phase).toBe("idle");
    expect(updater.status().availableVersion).toBeNull();
    expect(await readPendingMarker(stateDir)).toBeNull();
  });
});
