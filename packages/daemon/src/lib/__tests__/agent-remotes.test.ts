import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "@tmux-ide/contracts";
import { listSshAgentSources, resolveSshMachineUrl, sshMachineId } from "../agent-remotes.ts";

const agent: AgentRecord = {
  id: "proj:%1",
  kind: "managed",
  tool: "claude",
  name: "René",
  status: "busy",
  session: "proj",
  paneId: "%1",
  paneTitle: "Claude Code",
  cwd: "/srv/proj",
  taskId: null,
  taskTitle: null,
  pid: 7,
  lastActivity: "2026-01-01T00:00:00.000Z",
  machineId: null,
  machineName: null,
};

let dir: string;
let storeFile: string;
const originalFetch = globalThis.fetch;

function writeRemotes(remotes: object[]): void {
  writeFileSync(storeFile, JSON.stringify({ version: 1, remotes }, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-remotes-"));
  storeFile = join(dir, "ssh-remotes.json");
  process.env.TMUX_IDE_SSH_REMOTES_FILE = storeFile;
});

afterEach(() => {
  delete process.env.TMUX_IDE_SSH_REMOTES_FILE;
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("sshMachineId / resolveSshMachineUrl", () => {
  it("resolves a configured remote's tunnel url from lastLocalPort", async () => {
    writeRemotes([
      { name: "boxa", host: "boxa-ssm", path: "/srv/p", addedAt: "x", lastLocalPort: 7777 },
    ]);
    expect(sshMachineId("boxa")).toBe("ssh:boxa");
    expect(await resolveSshMachineUrl("ssh:boxa")).toBe("http://127.0.0.1:7777");
  });

  it("prefers the pinned localPort over lastLocalPort", async () => {
    writeRemotes([
      {
        name: "boxa",
        host: "h",
        path: "/p",
        addedAt: "x",
        localPort: 6061,
        lastLocalPort: 7777,
      },
    ]);
    expect(await resolveSshMachineUrl("ssh:boxa")).toBe("http://127.0.0.1:6061");
  });

  it("returns null for non-ssh machine ids, unknown remotes, and tunnel-less remotes", async () => {
    writeRemotes([{ name: "no-tunnel", host: "h", path: "/p", addedAt: "x" }]);
    expect(await resolveSshMachineUrl("some-hq-uuid")).toBeNull();
    expect(await resolveSshMachineUrl("ssh:ghost")).toBeNull();
    expect(await resolveSshMachineUrl("ssh:no-tunnel")).toBeNull();
  });
});

describe("listSshAgentSources", () => {
  it("returns reachable tunnels as agent sources and skips dead ones", async () => {
    writeRemotes([
      { name: "boxa", host: "h", path: "/p", addedAt: "x", lastLocalPort: 7001 },
      { name: "boxb", host: "h", path: "/p", addedAt: "x", lastLocalPort: 7002 },
      { name: "no-tunnel", host: "h", path: "/p", addedAt: "x" },
    ]);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:7001/")) {
        return new Response(JSON.stringify({ agents: [agent] }), { status: 200 });
      }
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;

    const sources = await listSshAgentSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ machineId: "ssh:boxa", machineName: "boxa" });
    expect(sources[0]!.agents[0]!.id).toBe("proj:%1");
    // the tunnel-less remote is never probed
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(calls.some((u) => u.includes("7001"))).toBe(true);
    expect(calls.some((u) => u.includes("7002"))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("dedupes store entries that share a tunnel url, preferring the freshest launch", async () => {
    writeRemotes([
      { name: "stale", host: "h", path: "/old", addedAt: "x", localPort: 7001 },
      {
        name: "fresh",
        host: "h",
        path: "/new",
        addedAt: "x",
        localPort: 7001,
        lastLaunchedAt: "2026-07-02T00:00:00.000Z",
      },
    ]);
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ agents: [agent] }), { status: 200 }),
    ) as typeof fetch;
    const sources = await listSshAgentSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.machineName).toBe("fresh");
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("skips a remote whose response fails schema validation", async () => {
    writeRemotes([{ name: "boxa", host: "h", path: "/p", addedAt: "x", lastLocalPort: 7001 }]);
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ agents: "not-an-array" }), { status: 200 }),
    ) as typeof fetch;
    expect(await listSshAgentSources()).toEqual([]);
  });

  it("skips a remote that answers with a redirect", async () => {
    writeRemotes([{ name: "boxa", host: "h", path: "/p", addedAt: "x", lastLocalPort: 7001 }]);
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "http://evil" } }),
    ) as typeof fetch;
    expect(await listSshAgentSources()).toEqual([]);
  });
});
