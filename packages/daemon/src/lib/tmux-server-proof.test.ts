import { createNamedSocketFence } from "./tmux-named-socket-fence.ts";
import { captureUnixSocketIdentity } from "./unix-socket-authority.ts";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  captureTmuxServerProof,
  captureTmuxServerProofAsync,
  captureUnboundTmuxSelectorProof,
} from "./tmux-server-proof.ts";

describe("tmux server proof", () => {
  it("requires a stable live socket and bounds proof to one server incarnation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-proof-"));
    const socket = join(root, "s");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    try {
      const authority = {
        executablePath: process.execPath,
        socketSelector: { kind: "name", name: "private-test" } as const,
      };
      const commitment = captureUnboundTmuxSelectorProof(authority);
      expect(commitment).toMatchObject({ kind: "unbound-name" });
      expect(
        captureUnboundTmuxSelectorProof({
          ...authority,
          socketSelector: { kind: "name", name: "other" },
        }),
      ).not.toEqual(commitment);
      createNamedSocketFence(authority, process.execPath, {}).observe(
        captureUnixSocketIdentity(socket),
      );
      expect(captureUnboundTmuxSelectorProof(authority)).toBeNull();
      const run = vi.fn(() => `${socket}|123|456`);
      const proof = captureTmuxServerProof(run);
      expect(proof).toMatchObject({ version: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(JSON.stringify(proof)).not.toContain(socket);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls).toEqual([
        [["-N", "display-message", "-p", "#{socket_path}|#{pid}|#{start_time}"]],
        [["-N", "display-message", "-p", "#{socket_path}|#{pid}|#{start_time}"]],
      ]);
      expect(await captureTmuxServerProofAsync(async () => `${socket}|123|456`)).toEqual(proof);
      expect(captureTmuxServerProof(() => `${socket}|123|457`)).not.toEqual(proof);
      let reads = 0;
      expect(captureTmuxServerProof(() => `${socket}|123|${++reads}`)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not fabricate proof for unavailable or malformed servers", async () => {
    expect(captureTmuxServerProof(() => "/missing/socket|123|456")).toBeNull();
    expect(captureTmuxServerProof(() => "not a server")).toBeNull();
    expect(
      await captureTmuxServerProofAsync(async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });
});
