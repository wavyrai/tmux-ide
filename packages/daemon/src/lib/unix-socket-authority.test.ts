import { chmodSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  birthtimeIdentifiesFile,
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "./unix-socket-authority.ts";

const roots: string[] = [];
const servers: Server[] = [];

async function socketAt(path: string): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Unix socket authority", () => {
  it("canonicalizes only the parent and revalidates the exact live socket inode", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-socket-authority-"));
    roots.push(root);
    const path = join(root, "t.sock");
    const first = await socketAt(path);
    const identity = captureUnixSocketIdentity(path);
    expect(revalidateUnixSocketIdentity(identity)).toBe(identity.path);
    await new Promise<void>((resolve) => first.close(() => resolve()));
    servers.splice(servers.indexOf(first), 1);
    const second = await socketAt(path);
    expect(second.listening).toBe(true);
    expect(() => revalidateUnixSocketIdentity(identity)).toThrow(/changed before use/u);
  });

  it("accepts benign socket metadata changes made by an attached client", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-socket-metadata-"));
    roots.push(root);
    const path = join(root, "t.sock");
    await socketAt(path);
    const identity = captureUnixSocketIdentity(path);
    chmodSync(path, 0o600);
    expect(revalidateUnixSocketIdentity(identity)).toBe(identity.path);
  });

  // Bug sweep, section A: `touch` on a healthy server's socket retired its owner.
  it("still knows the socket after its modification time changed, where creation time identifies it", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-socket-touch-"));
    roots.push(root);
    const path = join(root, "t.sock");
    await socketAt(path);
    const identity = captureUnixSocketIdentity(path);
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later); // what `touch` does
    if (birthtimeIdentifiesFile(process.platform))
      expect(revalidateUnixSocketIdentity(identity)).toBe(identity.path);
    else expect(() => revalidateUnixSocketIdentity(identity)).toThrow(/changed before use/u);
  });

  it("uses the creation time only on platforms that record one", () => {
    expect(birthtimeIdentifiesFile("darwin")).toBe(true);
    expect(birthtimeIdentifiesFile("freebsd")).toBe(true);
    expect(birthtimeIdentifiesFile("linux")).toBe(false);
    expect(birthtimeIdentifiesFile("win32")).toBe(false);
  });

  it("a different creation time is a different socket even with the same device and inode", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-socket-birth-"));
    roots.push(root);
    const path = join(root, "t.sock");
    await socketAt(path);
    const identity = captureUnixSocketIdentity(path);
    expect(() =>
      revalidateUnixSocketIdentity({ ...identity, birthtimeNs: identity.birthtimeNs + 1n }),
    ).toThrow(/changed before use/u);
  });

  it("rejects missing, regular, relative, oversized, final-symlink, and parent-symlink paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-socket-reject-"));
    roots.push(root);
    const socketPath = join(root, "live.sock");
    await socketAt(socketPath);
    expect(() => captureUnixSocketIdentity(join(root, "missing.sock"))).toThrow();
    const regular = join(root, "regular");
    writeFileSync(regular, "x");
    expect(() => captureUnixSocketIdentity(regular)).toThrow(/authority is invalid/u);
    expect(() => captureUnixSocketIdentity("relative.sock")).toThrow(/path is invalid/u);
    expect(() => captureUnixSocketIdentity(`/${"x".repeat(4_097)}`)).toThrow(/path is invalid/u);
    const finalLink = join(root, "final-link.sock");
    symlinkSync(socketPath, finalLink);
    expect(() => captureUnixSocketIdentity(finalLink)).toThrow(/authority is invalid/u);
    const parentLink = join(root, "parent-link");
    symlinkSync(root, parentLink);
    expect(() => captureUnixSocketIdentity(join(parentLink, "live.sock"))).toThrow(
      /authority is invalid/u,
    );
  });
});
