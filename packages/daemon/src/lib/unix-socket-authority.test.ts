import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
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
