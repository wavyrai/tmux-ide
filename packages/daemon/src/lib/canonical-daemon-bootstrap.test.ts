import { describe, expect, it, vi } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import type { CanonicalDaemonInfo } from "./canonical-daemon.ts";
import {
  createCanonicalDaemonBootstrapCoordinator,
  ensureCanonicalDaemon,
  retireOutdatedCanonicalDaemon,
} from "./canonical-daemon-bootstrap.ts";

const info: CanonicalDaemonInfo = {
  pid: 42,
  port: 6060,
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-08-12T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner",
};

describe("canonical daemon bootstrap adapter", () => {
  it("reuses a generation only after identity and protocol proof", async () => {
    const spawnOwner = vi.fn(async () => undefined);
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/tmp/cli.js" },
      {
        inspect: () => ({ status: "valid", info, observation: { path: "/tmp/daemon.json" } }),
        alive: async () => true,
        identity: async () => ({
          ok: true,
          pid: info.pid,
          protocolVersion: info.protocolVersion,
          productVersion: info.productVersion,
          instanceId: info.instanceId,
          startedAt: info.startedAt,
        }),
        health: async () => ({
          ok: true,
          protocolVersion: info.protocolVersion,
          productVersion: info.productVersion,
          uptime: 1,
        }),
        spawnOwner,
      },
    );
    await expect(coordinator.ensure()).resolves.toMatchObject({
      candidate: info,
      source: "existing",
    });
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  it("spawns the sole headless owner and waits for publication", async () => {
    let published = false;
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () =>
          published
            ? ({ status: "valid", info, observation: { path: "/tmp/daemon.json" } } as const)
            : ({ status: "missing", observation: { path: "/tmp/daemon.json" } } as const),
        spawnOwner: async () => {
          published = true;
        },
        alive: async () => true,
        identity: async () => ({
          ok: true,
          pid: info.pid,
          protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
          productVersion: "2.8.0",
          instanceId: info.instanceId,
          startedAt: info.startedAt,
        }),
        health: async () => ({
          ok: true,
          protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
          productVersion: "2.8.0",
          uptime: 1,
        }),
      },
    );
    await expect(coordinator.ensure()).resolves.toMatchObject({
      source: "started",
      candidate: info,
    });
  });

  it("retires an exact older protocol owner before spawning the current generation", async () => {
    const events: string[] = [];
    const older = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 };
    const current = { ...info, pid: 84, instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49" };
    let state: "older" | "missing" | "current" = "older";
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () =>
          state === "missing"
            ? { status: "missing", observation: { path: "/tmp/daemon.json" } }
            : {
                status: "valid",
                info: state === "older" ? older : current,
                observation: { path: "/tmp/daemon.json" },
              },
        alive: async (candidate) =>
          (state === "older" && candidate.instanceId === older.instanceId) ||
          (state === "current" && candidate.instanceId === current.instanceId),
        identity: async (candidate) => ({
          ok: true,
          pid: candidate.pid,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          instanceId: candidate.instanceId,
          startedAt: candidate.startedAt,
        }),
        health: async (candidate) => ({
          ok: true,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          uptime: 1,
        }),
        shutdownOlderOwner: async (candidate) => {
          expect(candidate).toBe(older);
          events.push("shutdown-older");
          state = "missing";
        },
        spawnOwner: async () => {
          events.push("spawn-current");
          state = "current";
        },
        now: (() => {
          let now = 0;
          return () => now++;
        })(),
        sleep: async () => undefined,
      },
    );
    expect(events).toEqual(["shutdown-older", "spawn-current"]);
    expect(result).toMatchObject({ source: "started", candidate: current });
  });

  it("never lets an older client retire a newer protocol owner", async () => {
    const newer = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION + 1 };
    const shutdownOlderOwner = vi.fn(async () => undefined);
    await expect(
      ensureCanonicalDaemon(
        { entryPath: "/tmp/cli.js", timeoutMs: 100 },
        {
          inspect: () => ({
            status: "valid",
            info: newer,
            observation: { path: "/tmp/daemon.json" },
          }),
          alive: async () => true,
          identity: async () => ({
            ok: true,
            pid: newer.pid,
            protocolVersion: newer.protocolVersion,
            productVersion: newer.productVersion,
            instanceId: newer.instanceId,
            startedAt: newer.startedAt,
          }),
          health: async () => ({
            ok: true,
            protocolVersion: newer.protocolVersion,
            productVersion: newer.productVersion,
            uptime: 1,
          }),
          shutdownOlderOwner,
        },
      ),
    ).rejects.toMatchObject({ code: "incompatible", reason: "protocol-mismatch" });
    expect(shutdownOlderOwner).not.toHaveBeenCalled();
  });

  it("adopts a current generation installed by a concurrent upgrader", async () => {
    const older = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 };
    const current = { ...info, pid: 84, instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49" };
    let inspections = 0;
    const shutdownOlderOwner = vi.fn(async () => undefined);
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () => ({
          status: "valid",
          info: inspections++ === 0 ? older : current,
          observation: { path: "/tmp/daemon.json" },
        }),
        alive: async () => true,
        identity: async (candidate) => ({
          ok: true,
          pid: candidate.pid,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          instanceId: candidate.instanceId,
          startedAt: candidate.startedAt,
        }),
        health: async (candidate) => ({
          ok: true,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          uptime: 1,
        }),
        shutdownOlderOwner,
      },
    );

    expect(result).toMatchObject({ source: "existing", candidate: current });
    expect(shutdownOlderOwner).not.toHaveBeenCalled();
  });

  it("starts current after a concurrent upgrader removes the old record", async () => {
    const older = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 };
    const current = { ...info, pid: 84, instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49" };
    let inspections = 0;
    const spawnOwner = vi.fn(async () => undefined);
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () => {
          inspections += 1;
          if (inspections === 1) {
            return {
              status: "valid" as const,
              info: older,
              observation: { path: "/tmp/daemon.json" },
            };
          }
          if (inspections <= 3) {
            return { status: "missing" as const, observation: { path: "/tmp/daemon.json" } };
          }
          return {
            status: "valid" as const,
            info: current,
            observation: { path: "/tmp/daemon.json" },
          };
        },
        alive: async () => true,
        identity: async (candidate) => ({
          ok: true,
          pid: candidate.pid,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          instanceId: candidate.instanceId,
          startedAt: candidate.startedAt,
        }),
        health: async (candidate) => ({
          ok: true,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          uptime: 1,
        }),
        spawnOwner,
      },
    );

    expect(result).toMatchObject({ source: "started", candidate: current });
    expect(spawnOwner).toHaveBeenCalledOnce();
  });

  it("converges when a duplicate shutdown loses the exact old owner race", async () => {
    const older = { ...info, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION - 1 };
    const current = { ...info, pid: 84, instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49" };
    let state: "older" | "current" = "older";
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/cli.js", timeoutMs: 100 },
      {
        inspect: () => ({
          status: "valid",
          info: state === "older" ? older : current,
          observation: { path: "/tmp/daemon.json" },
        }),
        alive: async () => true,
        identity: async (candidate) => ({
          ok: true,
          pid: candidate.pid,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          instanceId: candidate.instanceId,
          startedAt: candidate.startedAt,
        }),
        health: async (candidate) => ({
          ok: true,
          protocolVersion: candidate.protocolVersion,
          productVersion: candidate.productVersion,
          uptime: 1,
        }),
        shutdownOlderOwner: async () => {
          state = "current";
          throw new Error("the other upgrader already closed this owner");
        },
      },
    );

    expect(result).toMatchObject({ source: "existing", candidate: current });
  });
});

describe("product version upgrades", () => {
  function fixture(version: string) {
    let current: CanonicalDaemonInfo | null = { ...info, productVersion: version };
    const shutdownOlderOwner = vi.fn(async () => {
      current = null;
    });
    const spawnOwner = vi.fn(async () => {
      current = {
        ...info,
        productVersion: "2.8.0-beta.11",
        pid: 84,
        instanceId: "1d78b1af-d7b7-4d30-84af-54e337f02b49",
      };
    });
    const dependencies = {
      inspect: () =>
        current
          ? { status: "valid" as const, info: current, observation: { path: "/tmp/daemon.json" } }
          : { status: "missing" as const, observation: { path: "/tmp/daemon.json" } },
      alive: async () => true,
      identity: async (candidate: CanonicalDaemonInfo) => ({ ...candidate, ok: true as const }),
      health: async (candidate: CanonicalDaemonInfo) => ({
        ok: true as const,
        protocolVersion: candidate.protocolVersion,
        productVersion: candidate.productVersion,
        uptime: 1,
      }),
      shutdownOlderOwner,
      spawnOwner,
    };
    return { dependencies, shutdownOlderOwner, spawnOwner };
  }
  const options = {
    entryPath: "/tmp/cli.js",
    expectedProductVersion: "2.8.0-beta.11",
    timeoutMs: 100,
  };

  it.each(["2.8.0-beta.9", "2.8.0-beta.10", "2.7.99", "2.8.0-alpha.99"])(
    "upgrades older %s through authenticated retirement and election",
    async (version) => {
      const f = fixture(version);
      await expect(ensureCanonicalDaemon(options, f.dependencies)).resolves.toMatchObject({
        candidate: { productVersion: options.expectedProductVersion },
      });
      expect(f.shutdownOlderOwner).toHaveBeenCalledTimes(1);
      expect(f.spawnOwner).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["2.8.0-beta.11", "2.8.0-beta.11+other", "2.8.0-beta.12", "2.8.0", "3.0.0"])(
    "does not downgrade or restart %s",
    async (version) => {
      const f = fixture(version);
      await expect(ensureCanonicalDaemon(options, f.dependencies)).resolves.toMatchObject({
        source: "existing",
      });
      expect(f.shutdownOlderOwner).not.toHaveBeenCalled();
      expect(f.spawnOwner).not.toHaveBeenCalled();
    },
  );
  it.each(["unknown", "2.8", "2.8.0-beta.01", "02.8.0", ""])(
    "does not retire unverifiable version %s",
    async (version) => {
      const f = fixture(version);
      await expect(ensureCanonicalDaemon(options, f.dependencies)).rejects.toMatchObject({
        reason: "product-version-mismatch",
      });
      expect(f.shutdownOlderOwner).not.toHaveBeenCalled();
      expect(f.spawnOwner).not.toHaveBeenCalled();
    },
  );
  it("reproves product identity before shutdown", async () => {
    const f = fixture("2.8.0-beta.9");
    let probes = 0;
    f.dependencies.identity = async (candidate) => ({
      ...candidate,
      ok: true,
      productVersion: ++probes === 1 ? candidate.productVersion : "2.8.0-beta.12",
    });
    await expect(ensureCanonicalDaemon(options, f.dependencies)).rejects.toMatchObject({
      reason: "identity-mismatch",
    });
    expect(f.shutdownOlderOwner).not.toHaveBeenCalled();
  });
  it("concurrent product upgraders converge on the elected replacement", async () => {
    const f = fixture("2.8.0-beta.9");
    const results = await Promise.all([
      ensureCanonicalDaemon(options, f.dependencies),
      ensureCanonicalDaemon(options, f.dependencies),
    ]);
    expect(results.map((result) => result.candidate.productVersion)).toEqual([
      options.expectedProductVersion,
      options.expectedProductVersion,
    ]);
  });
  it("does not retire an owner without authentication", async () => {
    const f = fixture("2.8.0-beta.9");
    const inspect = f.dependencies.inspect;
    f.dependencies.inspect = () => {
      const state = inspect();
      return state.status === "valid"
        ? { ...state, info: { ...state.info, authToken: undefined } }
        : state;
    };
    await expect(ensureCanonicalDaemon(options, f.dependencies)).rejects.toMatchObject({
      reason: "identity-mismatch",
    });
    expect(f.shutdownOlderOwner).not.toHaveBeenCalled();
  });
  it.each([
    [200, "shutdown_already_in_progress"],
    [409, "shutdown_already_in_progress"],
    [200, "daemon_instance_mismatch"],
    [409, "daemon_instance_mismatch"],
  ] as const)("only adopts the exact already-retiring conflict: %s %s", async (status, code) => {
    const f = fixture("2.8.0-beta.9");
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer owner" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        expectedInstanceId: info.instanceId,
      });
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ ok: false, error: { code } }), { status: 409 });
    });
    vi.stubGlobal("fetch", request);
    try {
      const { shutdownOlderOwner, ...rest } = f.dependencies;
      void shutdownOlderOwner;
      const dependencies = { ...rest, alive: async () => request.mock.calls.length === 0 };
      if (code === "shutdown_already_in_progress") {
        await expect(retireOutdatedCanonicalDaemon(options, dependencies)).resolves.toBe(true);
      } else {
        await expect(retireOutdatedCanonicalDaemon(options, dependencies)).rejects.toMatchObject({
          code: "incompatible",
        });
      }
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("can retire for foreground startup without spawning a background owner", async () => {
    const f = fixture("2.8.0-beta.9");
    await expect(retireOutdatedCanonicalDaemon(options, f.dependencies)).resolves.toBe(true);
    expect(f.shutdownOlderOwner).toHaveBeenCalledTimes(1);
    expect(f.spawnOwner).not.toHaveBeenCalled();
  });
});

describe("supervised bootstrap admission", () => {
  const observed = { dev: 1, ino: 1, size: 1, mtimeMs: 1 };
  const supervised = { ...info, supervisionId: "fixture" };
  const reservation = {
    status: "reserved" as const,
    reservation: {
      kind: "supervised-reservation" as const,
      version: 1 as const,
      supervisionId: "fixture",
      reservationId: "11111111-1111-4111-8111-111111111111",
      reservedAt: info.startedAt,
    },
    observation: observed,
    reason: "supervised-reservation" as const,
    detail: "reserved",
    ownerPid: null,
  };
  function fixture() {
    let state: import("./canonical-daemon.ts").CanonicalDaemonInfoState = reservation;
    let now = 0;
    let alive = false;
    const spawnOwner = vi.fn(async () => {});
    const dependencies = {
      inspect: () => state,
      alive: async () => alive,
      spawnOwner,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      identity: async (i: CanonicalDaemonInfo) => ({
        ok: true as const,
        pid: i.pid,
        instanceId: i.instanceId,
        startedAt: i.startedAt,
        protocolVersion: i.protocolVersion,
        productVersion: i.productVersion,
      }),
      health: async (i: CanonicalDaemonInfo) => ({
        ok: true as const,
        protocolVersion: i.protocolVersion,
        productVersion: i.productVersion,
        uptime: 1,
      }),
    };
    return {
      dependencies,
      spawnOwner,
      set: (next: typeof state, live = false) => {
        state = next;
        alive = live;
      },
      publish: () => {
        state = { status: "valid", info: supervised, observation: observed };
        alive = true;
      },
      tick: (ms: number) => {
        now += ms;
      },
    };
  }
  it("waits for reserved and dead supervised owners, with bounded timeout and no detached spawn", async () => {
    for (const state of [
      reservation,
      { status: "valid" as const, info: supervised, observation: observed },
    ]) {
      const f = fixture();
      f.set(state);
      await expect(
        ensureCanonicalDaemon({ entryPath: "/tmp/unused", timeoutMs: 100 }, f.dependencies),
      ).rejects.toMatchObject({ code: "control-timeout" });
      expect(f.spawnOwner).not.toHaveBeenCalled();
    }
  });
  it("adopts the supervisor publication and refuses changed reservation instead of falling back", async () => {
    const f = fixture();
    const result = await ensureCanonicalDaemon(
      { entryPath: "/tmp/unused", timeoutMs: 100 },
      {
        ...f.dependencies,
        sleep: async (ms) => {
          f.tick(ms);
          f.publish();
        },
      },
    );
    expect(result.candidate).toEqual(supervised);
    expect(f.spawnOwner).not.toHaveBeenCalled();
    const changed = fixture();
    await expect(
      ensureCanonicalDaemon(
        { entryPath: "/tmp/unused", timeoutMs: 100 },
        {
          ...changed.dependencies,
          sleep: async (ms) => {
            changed.tick(ms);
            changed.set({
              ...reservation,
              reservation: { ...reservation.reservation, supervisionId: "other" },
            });
          },
        },
      ),
    ).rejects.toMatchObject({ reason: "canonical-record-invalid" });
    expect(changed.spawnOwner).not.toHaveBeenCalled();
  });
  it("concurrent upgraders wait for replacement, including a disappearing record, without owning startup", async () => {
    const f = fixture();
    const older = { ...supervised, productVersion: "2.7.0" };
    f.set({ status: "valid", info: older, observation: observed }, true);
    const dependencies = {
      ...f.dependencies,
      shutdownOlderOwner: async () => {
        f.set({ status: "missing" });
      },
      sleep: async (ms: number) => {
        f.tick(ms);
        f.publish();
      },
    };
    const results = await Promise.all(
      [0, 1].map(() =>
        ensureCanonicalDaemon(
          { entryPath: "/tmp/unused", expectedProductVersion: info.productVersion, timeoutMs: 100 },
          dependencies,
        ),
      ),
    );
    expect(results.every((r) => r.candidate.instanceId === supervised.instanceId)).toBe(true);
    expect(f.spawnOwner).not.toHaveBeenCalled();
  });
  it.each([undefined, "fixture"])(
    "refuses binding replacement during retirement liveness checks (declared %s)",
    async (supervisionId) => {
      const f = fixture();
      const older = { ...supervised, productVersion: "2.7.0" };
      f.set({ status: "valid", info: older, observation: observed }, true);
      const shutdownOlderOwner = vi.fn(async () => {});
      await expect(
        retireOutdatedCanonicalDaemon(
          {
            entryPath: "/tmp/unused",
            expectedProductVersion: info.productVersion,
            timeoutMs: 100,
            supervisionId,
          },
          {
            ...f.dependencies,
            shutdownOlderOwner,
            alive: async () => {
              f.set(
                {
                  status: "valid",
                  info: { ...older, supervisionId: "replacement" },
                  observation: observed,
                },
                true,
              );
              return true;
            },
          },
        ),
      ).rejects.toMatchObject({ reason: "canonical-record-invalid" });
      expect(shutdownOlderOwner).not.toHaveBeenCalled();
      expect(f.spawnOwner).not.toHaveBeenCalled();
    },
  );
  it("foreground retirement waits for supervisor replacement instead of permitting a takeover", async () => {
    const f = fixture();
    f.set(
      { status: "valid", info: { ...supervised, productVersion: "2.7.0" }, observation: observed },
      true,
    );
    const result = await retireOutdatedCanonicalDaemon(
      { entryPath: "/tmp/unused", expectedProductVersion: info.productVersion, timeoutMs: 100 },
      {
        ...f.dependencies,
        shutdownOlderOwner: async () => {
          f.set(reservation);
        },
        sleep: async (ms) => {
          f.tick(ms);
          f.publish();
        },
      },
    );
    expect(result).toBe(false);
    expect(f.spawnOwner).not.toHaveBeenCalled();
  });
});

describe("canonical server intent admission", () => {
  const digest = "a".repeat(64);
  const intent = { source: "explicit", selector: { kind: "name", name: "default" } } as const;
  function dependencies(
    options: {
      capability?: boolean;
      digest?: string | null;
      old?: boolean;
      unbound?: boolean;
    } = {},
  ) {
    const candidate = {
      ...info,
      productVersion: options.old ? "2.7.0" : info.productVersion,
      ...(options.capability === false ? {} : { tmuxServerProofVersion: 1 as const }),
    };
    return {
      inspect: () => ({
        status: "valid" as const,
        info: candidate,
        observation: { path: "/tmp/daemon.json" },
      }),
      alive: async () => true,
      identity: async () => ({
        ...candidate,
        ok: true as const,
        tmuxServerProof:
          options.digest === null
            ? null
            : {
                version: 1 as const,
                kind: options.unbound ? ("unbound-name" as const) : ("live" as const),
                digest: options.digest ?? digest,
              },
      }),
      health: async () => ({
        ok: true as const,
        protocolVersion: candidate.protocolVersion,
        productVersion: candidate.productVersion,
        uptime: 1,
      }),
      serverProof: vi.fn(() => ({
        version: 1 as const,
        kind: options.unbound ? ("unbound-name" as const) : ("live" as const),
        digest,
      })),
      spawnOwner: vi.fn(async () => undefined),
      shutdownOlderOwner: vi.fn(async () => undefined),
    };
  }
  it("admits the exact same unbound named selector for a sessionless owner", async () => {
    const deps = dependencies({ unbound: true });
    await expect(
      ensureCanonicalDaemon({ entryPath: "/tmp/cli.js", tmuxServerIntent: intent }, deps),
    ).resolves.toMatchObject({ source: "existing" });
    expect(deps.shutdownOlderOwner).not.toHaveBeenCalled();
  });
  it("does not substitute a selector commitment for a live server proof", async () => {
    const deps = dependencies({ unbound: true });
    const originalIdentity = deps.identity;
    deps.identity = async () => ({
      ...(await originalIdentity()),
      tmuxServerProof: { version: 1, kind: "live", digest },
    });
    await expect(
      ensureCanonicalDaemon({ entryPath: "/tmp/cli.js", tmuxServerIntent: intent }, deps),
    ).rejects.toMatchObject({ reason: "tmux-server-mismatch" });
    expect(deps.shutdownOlderOwner).not.toHaveBeenCalled();
  });
  it("reuses the same proven server", async () => {
    const deps = dependencies();
    await expect(
      ensureCanonicalDaemon({ entryPath: "/tmp/cli.js", tmuxServerIntent: intent }, deps),
    ).resolves.toMatchObject({ source: "existing" });
    expect(deps.spawnOwner).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "refuses a different server before replacement (older=%s)",
    async (old) => {
      const deps = dependencies({ digest: "b".repeat(64), old });
      await expect(
        ensureCanonicalDaemon(
          {
            entryPath: "/tmp/cli.js",
            expectedProductVersion: info.productVersion,
            tmuxServerIntent: intent,
          },
          deps,
        ),
      ).rejects.toMatchObject({ reason: "tmux-server-mismatch" });
      expect(deps.spawnOwner).not.toHaveBeenCalled();
      expect(deps.shutdownOlderOwner).not.toHaveBeenCalled();
    },
  );
  it.each([{ capability: false }, { digest: null }])(
    "refuses unsupported or unavailable proof",
    async (options) => {
      const deps = dependencies(options);
      await expect(
        ensureCanonicalDaemon({ entryPath: "/tmp/cli.js", tmuxServerIntent: intent }, deps),
      ).rejects.toMatchObject({ reason: "tmux-server-unproven" });
      expect(deps.shutdownOlderOwner).not.toHaveBeenCalled();
      expect(deps.spawnOwner).not.toHaveBeenCalled();
    },
  );
  it("keeps context-free reuse compatible with older metadata", async () => {
    const deps = dependencies({ capability: false, digest: null });
    await expect(
      ensureCanonicalDaemon({ entryPath: "/tmp/cli.js", tmuxServerIntent: null }, deps),
    ).resolves.toMatchObject({ source: "existing" });
    expect(deps.serverProof).not.toHaveBeenCalled();
  });
  it("refuses foreground version retirement across server intent", async () => {
    const deps = dependencies({ old: true, digest: "b".repeat(64) });
    await expect(
      retireOutdatedCanonicalDaemon(
        {
          entryPath: "/tmp/cli.js",
          expectedProductVersion: info.productVersion,
          tmuxServerIntent: intent,
        },
        deps,
      ),
    ).rejects.toMatchObject({ reason: "tmux-server-mismatch" });
    expect(deps.shutdownOlderOwner).not.toHaveBeenCalled();
  });
});
