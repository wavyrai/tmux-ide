import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import type { CanonicalDaemonInfo } from "./canonical-daemon.ts";
import {
  ensureCanonicalDaemon,
  retireOutdatedCanonicalDaemon,
} from "./canonical-daemon-bootstrap.ts";

const old: CanonicalDaemonInfo = {
  pid: 42,
  port: 6060,
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.9.5",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-08-12T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner",
};
const options = {
  entryPath: "/tmp/cli.js",
  expectedProductVersion: "2.9.6",
  timeoutMs: 100,
  tmuxServerIntent: null,
};
function fixture(retire: boolean) {
  let current: CanonicalDaemonInfo | null = old;
  let clock = 0;
  const spawnOwner = vi.fn(async () => {
    current = {
      ...old,
      pid: 84,
      instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49",
      productVersion: "2.9.6",
    };
  });
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
    if (retire && current === old) current = null;
  });
  return {
    spawnOwner,
    sleep,
    deps: {
      inspect: () =>
        current
          ? { status: "valid" as const, info: current, observation: { path: "/tmp/daemon.json" } }
          : { status: "missing" as const, observation: { path: "/tmp/daemon.json" } },
      identity: async (info: CanonicalDaemonInfo) => ({ ...info, ok: true as const }),
      health: async (info: CanonicalDaemonInfo) => ({
        ok: true as const,
        protocolVersion: info.protocolVersion,
        productVersion: info.productVersion,
        uptime: 1,
      }),
      alive: async () => true,
      now: () => clock,
      sleep,
      spawnOwner,
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe.each(["ensure", "retire"] as const)(
  "%s after competing shutdown closes the listener before record cleanup",
  (mode) => {
    const invoke = (f: ReturnType<typeof fixture>) =>
      mode === "ensure"
        ? ensureCanonicalDaemon(options, f.deps)
        : retireOutdatedCanonicalDaemon(options, f.deps);
    it("waits for retirement evidence without sending shutdown twice", async () => {
      const f = fixture(true);
      const transport = new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
      const request = vi.fn(async () => {
        throw transport;
      });
      vi.stubGlobal("fetch", request);
      const result = await invoke(f);
      if (mode === "ensure")
        expect(result).toMatchObject({ candidate: { productVersion: "2.9.6" } });
      else expect(result).toBe(true);
      expect(f.sleep).toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
      expect(f.spawnOwner).toHaveBeenCalledTimes(mode === "ensure" ? 1 : 0);
    });
    it("preserves transport failure when the same owner remains alive", async () => {
      const f = fixture(false);
      const transport = new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      });
      const request = vi.fn(async () => {
        throw transport;
      });
      vi.stubGlobal("fetch", request);
      await expect(invoke(f)).rejects.toBe(transport);
      expect(request).toHaveBeenCalledTimes(1);
      expect(f.spawnOwner).not.toHaveBeenCalled();
    });
    it("does not wait away an explicit authenticated shutdown refusal", async () => {
      const f = fixture(true);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ ok: false, error: { code: "daemon_instance_mismatch" } }),
              { status: 409 },
            ),
        ),
      );
      await expect(invoke(f)).rejects.toMatchObject({ code: "incompatible" });
      expect(f.sleep).not.toHaveBeenCalled();
      expect(f.spawnOwner).not.toHaveBeenCalled();
    });
  },
);
