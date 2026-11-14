import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  birthtimeIdentifiesFile,
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
  unixSocketPathLimit,
  UnixSocketPathTooLongError,
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

  describe("a socket whose canonical path does not fit sockaddr_un (#384)", () => {
    const limit = unixSocketPathLimit();
    /**
     * `<root>/a` links to a directory deep enough that the socket's canonical
     * path is `over` bytes past the limit. The socket is bound through the link.
     * `<root>` is made under `base`.
     */
    async function aliased(over: number, prefix = "", base = "/tmp") {
      const root = mkdtempSync(join(base, "usa-"));
      roots.push(root);
      const canonicalRoot = realpathSync(root);
      const pad =
        limit + over - Buffer.byteLength(join(canonicalRoot, "r", `${prefix}p`, "d", "t.sock")) + 1;
      const deep = join(root, "r", prefix + "p".repeat(pad));
      mkdirSync(join(deep, "d"), { recursive: true });
      symlinkSync(deep, join(root, "a"));
      const alias = join(root, "a", "d", "t.sock");
      const canonical = join(realpathSync(join(deep, "d")), "t.sock");
      expect(Buffer.byteLength(canonical)).toBe(limit + over);
      expect(Buffer.byteLength(alias)).toBeLessThanOrEqual(limit);
      const server = await socketAt(alias);
      return { root, alias, canonical, server, deep };
    }

    it("knows the limit of each platform", () => {
      expect(unixSocketPathLimit("darwin")).toBe(103);
      expect(unixSocketPathLimit("freebsd")).toBe(103);
      expect(unixSocketPathLimit("linux")).toBe(107);
    });

    it("keeps a canonical path of exactly the limit", async () => {
      // No link here: the path given is already canonical.
      const root = realpathSync(mkdtempSync("/tmp/usa-"));
      roots.push(root);
      const pad = limit - Buffer.byteLength(join(root, "p", "t.sock")) + 1;
      const dir = join(root, "p".repeat(pad));
      mkdirSync(dir);
      const exact = join(dir, "t.sock");
      expect(Buffer.byteLength(exact)).toBe(limit);
      await socketAt(exact);
      expect(captureUnixSocketIdentity(exact).path).toBe(exact);
    });

    it("measures the canonical path in bytes, not characters", async () => {
      // Ten two-byte letters: 8 bytes over the limit, yet 2 characters under it.
      const { alias, canonical } = await aliased(8, "é".repeat(10));
      expect(canonical.length).toBeLessThan(limit);
      expect(captureUnixSocketIdentity(alias).path).toBe(alias);
    });

    it("connects through the caller's spelling and revalidates it", async () => {
      const { alias } = await aliased(8);
      const identity = captureUnixSocketIdentity(alias);
      expect(identity.path).toBe(alias);
      expect(revalidateUnixSocketIdentity(identity)).toBe(alias);
      // The alias is stable: capturing it again gives the same identity.
      expect(captureUnixSocketIdentity(identity.path)).toEqual(identity);
    });

    it("refuses an alias whose socket was replaced", async () => {
      const { alias, server } = await aliased(8);
      const identity = captureUnixSocketIdentity(alias);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      servers.splice(servers.indexOf(server), 1);
      await socketAt(alias);
      expect(() => revalidateUnixSocketIdentity(identity)).toThrow(/changed before use/u);
    });

    it("refuses an alias that now leads to another socket", async () => {
      const { root, alias } = await aliased(8);
      const identity = captureUnixSocketIdentity(alias);
      const other = join(root, "o");
      mkdirSync(join(other, "d"), { recursive: true });
      await socketAt(join(other, "d", "t.sock"));
      unlinkSync(join(root, "a"));
      symlinkSync(other, join(root, "a"));
      expect(() => revalidateUnixSocketIdentity(identity)).toThrow(/changed before use/u);
    });

    it("names the size and the limit when no spelling of the path fits", async () => {
      // Too long even without macOS's /private prefix.
      const { canonical } = await aliased(40);
      let thrown: unknown;
      try {
        captureUnixSocketIdentity(canonical);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnixSocketPathTooLongError);
      expect((thrown as Error).message).toBe(
        `The tmux socket path is ${limit + 40} bytes; this platform allows ${limit}. Start the tmux server on a shorter socket path.`,
      );
    });

    // macOS's own temp folders are under /var, a link to /private/var.
    it.runIf(process.platform === "darwin").each(["/tmp", "/var/tmp"])(
      "finds the %s spelling of an overlong /private path",
      async (base) => {
        const { alias, canonical } = await aliased(8, "", base);
        expect(canonical.startsWith(`/private${base}/`)).toBe(true);
        const identity = captureUnixSocketIdentity(canonical);
        expect(identity.path).toBe(canonical.slice("/private".length));
        expect(revalidateUnixSocketIdentity(identity)).toBe(identity.path);
        expect(captureUnixSocketIdentity(alias)).toMatchObject({
          dev: identity.dev,
          ino: identity.ino,
        });
      },
    );
  });
});
