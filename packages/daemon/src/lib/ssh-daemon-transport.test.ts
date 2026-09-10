import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  SshConnectionError,
  openSshDaemonTransport,
  probeSshDaemonIdentity,
  RemoteDaemonHandshakeSchema,
  type SshDaemonTransportDependencies,
  type SshTransportChild,
} from "./ssh-daemon-transport.ts";

const daemon = {
  pid: 99999999,
  port: 7331,
  protocolVersion: 2,
  productVersion: "2.9.0-beta.8",
  instanceId: "12345678-1234-4234-8234-123456789abc",
  startedAt: "2026-09-09T10:00:00.000Z",
  bindHostname: "127.0.0.1" as const,
  authToken: "private-token-never-log",
};
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }
  finish(payload: unknown, code = 0) {
    this.stdout.write(typeof payload === "string" ? payload : JSON.stringify(payload));
    this.exitCode = code;
    this.emit("close", code);
  }
}
function fixture(payload: unknown = { version: 1, daemon }) {
  const children: FakeChild[] = [];
  const argv: string[][] = [];
  const dependencies: SshDaemonTransportDependencies = {
    spawn(args) {
      argv.push(args);
      const child = new FakeChild();
      children.push(child);
      if (children.length === 1) queueMicrotask(() => child.finish(payload));
      return child as unknown as SshTransportChild;
    },
    allocatePort: async () => 43210,
    probe: async () => true,
  };
  return { dependencies, children, argv };
}
describe("owned SSH daemon transport", () => {
  it("uses fixed remote command and loopback forward without relaxing SSH trust", async () => {
    const f = fixture();
    const result = await openSshDaemonTransport({ alias: "work-machine" }, f.dependencies);
    expect(f.argv[0]).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "--",
      "work-machine",
      "tmux-ide",
      "remote-daemon-info",
      "--json",
    ]);
    expect(f.argv[1]).toContain("127.0.0.1:43210:127.0.0.1:7331");
    expect(f.argv.flat().join(" ")).not.toContain(daemon.authToken);
    expect(f.argv.flat().join(" ")).not.toContain("StrictHostKeyChecking");
    expect(result.daemon.pid).toBe(99999999); // Remote PID is data, never a local liveness check.
    expect(result.baseUrl).toBe("http://127.0.0.1:43210");
    result.dispose();
    result.dispose();
    await result.closed;
    expect(f.children[0].kills).toEqual([]);
    expect(f.children[1].kills).toEqual(["SIGTERM"]);
  });
  it("preserves remote localhost resolution for IPv6-only listeners", async () => {
    const f = fixture({ version: 1, daemon: { ...daemon, bindHostname: "localhost" } });
    const result = await openSshDaemonTransport({ alias: "host" }, f.dependencies);
    expect(f.argv[1]).toContain("127.0.0.1:43210:localhost:7331");
    result.dispose();
    await result.closed;
  });
  it("rejects readiness when SSH exits before close and a pending probe succeeds", async () => {
    const f = fixture();
    f.dependencies.probe = async () => {
      f.children[1].exitCode = 0;
      f.children[1].emit("exit", 0, null);
      return true;
    };
    await expect(openSshDaemonTransport({ alias: "host" }, f.dependencies)).rejects.toThrow(
      "tunnel could not authenticate",
    );
    // close may trail exit while inherited stdio remains open; it cannot revive readiness.
    f.children[1].emit("close", 0);
  });
  it("rejects incompatible, non-loopback, unauthenticated and unexpected descriptors", async () => {
    for (const modified of [
      { authToken: null },
      { bindHostname: "evil.example" },
      { protocolVersion: 99 },
      { extra: "bad" },
    ]) {
      const f = fixture({ version: 1, daemon: { ...daemon, ...modified } });
      await expect(openSshDaemonTransport({ alias: "host" }, f.dependencies)).rejects.toThrow(
        "invalid or incompatible",
      );
      expect(f.children).toHaveLength(1);
    }
    expect(RemoteDaemonHandshakeSchema.safeParse({ version: 1, daemon, extra: true }).success).toBe(
      false,
    );
  });
  it("rejects option injection before spawning", async () => {
    for (const alias of [
      "-oProxyCommand=evil",
      "host\ncommand",
      "",
      "two words",
      "user@host;evil",
      "host$(evil)",
      "x".repeat(256),
    ]) {
      const f = fixture();
      await expect(openSshDaemonTransport({ alias }, f.dependencies)).rejects.toThrow(
        "invalid SSH destination",
      );
      expect(f.children).toHaveLength(0);
    }
  });
  it("caps discovery output without revealing its contents", async () => {
    const f = fixture(daemon.authToken.repeat(3000));
    await expect(openSshDaemonTransport({ alias: "host" }, f.dependencies)).rejects.toThrow(
      "response exceeded limit",
    );
    expect(f.children).toHaveLength(1);
  });
  it("bounds discovery and kills only its owned process", async () => {
    const f = fixture();
    f.dependencies.spawn = () => {
      const child = new FakeChild();
      f.children.push(child);
      return child as unknown as SshTransportChild;
    };
    await expect(
      openSshDaemonTransport({ alias: "host", timeoutMs: 10 }, f.dependencies),
    ).rejects.toThrow("cancelled or timed out");
    expect(f.children[0].kills).toEqual(["SIGTERM"]);
  });
  it("bounds a probe that does not cooperate with cancellation", async () => {
    const f = fixture();
    f.dependencies.probe = () => new Promise(() => {});
    await expect(
      openSshDaemonTransport({ alias: "host", timeoutMs: 10 }, f.dependencies),
    ).rejects.toThrow("timeout");
    expect(f.children[1].kills).toEqual(["SIGTERM"]);
  });
  it("continues to own cancellation after readiness and signals tunnel loss", async () => {
    const f = fixture();
    const abort = new AbortController();
    const result = await openSshDaemonTransport(
      { alias: "host", signal: abort.signal },
      f.dependencies,
    );
    abort.abort();
    await result.closed;
    expect(f.children[1].kills).toEqual(["SIGTERM"]);
  });
  it("never exposes injected dependency error content", async () => {
    const f = fixture();
    f.dependencies.spawn = () => {
      throw new Error(daemon.authToken);
    };
    await expect(openSshDaemonTransport({ alias: "host" }, f.dependencies)).rejects.toThrow(
      "could not establish transport",
    );
  });
});
describe("SSH forwarded daemon identity", () => {
  it("does not send credentials to a wrong local listener", async () => {
    const requests: RequestInit[] = [];
    const request = (async (_input: unknown, init: RequestInit) => {
      requests.push(init);
      return Response.json({
        ok: true,
        ...daemon,
        instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });
    }) as typeof fetch;
    expect(
      await probeSshDaemonIdentity(
        "http://127.0.0.1:43210",
        daemon,
        new AbortController().signal,
        request,
      ),
    ).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers).toBeUndefined();
    expect(requests[0].redirect).toBe("error");
  });
  it("requires matching authenticated full identity, not only the public probe", async () => {
    const identity = {
      protocolVersion: daemon.protocolVersion,
      productVersion: daemon.productVersion,
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
    };
    for (const mismatch of [false, true]) {
      const requests: RequestInit[] = [];
      const request = (async (_input: unknown, init: RequestInit) => {
        requests.push(init);
        return requests.length === 1
          ? Response.json({ ok: true, ...daemon })
          : Response.json({
              status: "ok",
              daemon: { ...identity, productVersion: mismatch ? "other" : identity.productVersion },
              capabilities: { appWindowMutation: { available: false, reason: "not supported" } },
            });
      }) as typeof fetch;
      expect(
        await probeSshDaemonIdentity(
          "http://127.0.0.1:43210",
          daemon,
          new AbortController().signal,
          request,
        ),
      ).toBe(!mismatch);
      expect(requests).toHaveLength(2);
      expect(requests[1].headers).toEqual({
        Authorization: `Bearer ${daemon.authToken}`,
        "Content-Type": "application/json",
      });
    }
  });
  it("caps credential-free response before any bearer request", async () => {
    let calls = 0;
    const request = (async () => {
      calls++;
      return new Response("x".repeat(32769));
    }) as unknown as typeof fetch;
    await expect(
      probeSshDaemonIdentity(
        "http://127.0.0.1:43210",
        daemon,
        new AbortController().signal,
        request,
      ),
    ).rejects.toThrow("exceeded limit");
    expect(calls).toBe(1);
  });
});

it("uses structured preflight failures without opening a tunnel", async () => {
  for (const code of ["daemon-missing", "incompatible", "unavailable"] as const) {
    const f = fixture({ version: 1, error: { code } });
    const error = await openSshDaemonTransport({ alias: "host" }, f.dependencies).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(SshConnectionError);
    expect((error as SshConnectionError).code).toBe(code);
    expect((error as SshConnectionError).retryable).toBe(code === "unavailable");
    expect(f.children).toHaveLength(1);
  }
});
