import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../../../packages/contracts/src/index.ts";
import {
  discoverPreviewHost,
  DaemonCompatibilityError,
  DaemonDiscoveryError,
} from "./discovery.ts";

async function fixture(run: (path: string, info: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "gpui-discovery-"));
  const path = join(dir, "daemon.json");
  const info = {
    pid: process.pid,
    port: 45678,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "2.9.5",
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    bindHostname: "127.0.0.1",
    authToken: "test-only-secret",
  };
  try {
    await writeFile(path, JSON.stringify(info), { mode: 0o600 });
    await run(path, info);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const reply = (value: unknown) => new Response(JSON.stringify(value));

test("discovery probes identity without credentials, then selects verified scope", async () => {
  await fixture(async (path, info) => {
    let calls = 0;
    const serverId = `tmux-server.${randomUUID().replaceAll("-", "")}`,
      generation = randomUUID();
    const host = await discoverPreviewHost(path, async (_url, options) => {
      calls++;
      assert.equal(options?.redirect, "error");
      if (calls === 1) {
        assert.equal(options?.headers, undefined);
        return reply({ ...info, ok: true });
      }
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        `Bearer ${info.authToken}`,
      );
      return reply({
        version: 1,
        servers: [{ serverId, generation, label: "local", state: "online" }],
      });
    });
    assert.equal(calls, 2);
    assert.deepEqual(host.scope, { serverId, generation });
  });
});
test("wrong identity never receives credentials", async () => {
  await fixture(async (path, info) => {
    let calls = 0;
    await assert.rejects(
      discoverPreviewHost(path, async () => {
        calls++;
        return reply({ ...info, ok: true, instanceId: randomUUID() });
      }),
      /identity changed/,
    );
    assert.equal(calls, 1);
  });
});
test("non-loopback records are rejected before network access", async () => {
  await fixture(async (path, info) => {
    await writeFile(path, JSON.stringify({ ...info, bindHostname: "example.com" }));
    let calls = 0;
    await assert.rejects(
      discoverPreviewHost(path, async () => {
        calls++;
        return reply({});
      }),
    );
    assert.equal(calls, 0);
  });
});
test("ambiguous server selection and replaced records fail closed", async () => {
  for (const replace of [false, true])
    await fixture(async (path, info) => {
      let calls = 0;
      await assert.rejects(
        discoverPreviewHost(path, async () => {
          if (++calls === 1) return reply({ ...info, ok: true });
          const server = () => ({
            serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
            generation: randomUUID(),
            label: "local",
            state: "online",
          });
          if (replace) await writeFile(path, JSON.stringify({ ...info, instanceId: randomUUID() }));
          return reply({ version: 1, servers: replace ? [server()] : [server(), server()] });
        }),
        replace ? /record changed/ : /explicit private host/,
      );
    });
});

test("matching old and future protocols reject before authenticated discovery", async () => {
  for (const protocolVersion of [
    DAEMON_WIRE_PROTOCOL_VERSION - 1,
    DAEMON_WIRE_PROTOCOL_VERSION + 1,
  ]) {
    await fixture(async (path, info) => {
      info.protocolVersion = protocolVersion;
      await writeFile(path, JSON.stringify(info));
      const calls: { url: string; headers: unknown }[] = [];
      let failure: unknown;
      try {
        await discoverPreviewHost(path, async (url, options) => {
          calls.push({ url: String(url), headers: options?.headers });
          if (calls.length === 1) return reply({ ...info, ok: true });
          return reply({
            version: 1,
            servers: [
              {
                serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
                generation: randomUUID(),
                label: "local",
                state: "online",
              },
            ],
          });
        });
      } catch (error) {
        failure = error;
      }
      assert.equal(
        calls.length,
        1,
        "unsupported protocol must never receive an authenticated request",
      );
      assert.equal(calls[0]?.headers, undefined);
      assert.equal(new URL(calls[0]!.url).pathname, "/identity");
      assert.ok(failure instanceof DaemonCompatibilityError);
      assert.match(failure.message, /incompatible/i);
      assert.ok(failure.message.includes(String(protocolVersion)));
      assert.ok(!failure.message.includes(info.authToken));
    });
  }
});

test("fixed discovery categories distinguish absent owner, unavailable peer and server choice without secrets", async () => {
  await fixture(async (path, info) => {
    await rm(path);
    await assert.rejects(
      discoverPreviewHost(path, async () => {
        throw Error("must not request");
      }),
      (error) => error instanceof DaemonDiscoveryError && error.category === "no-daemon",
    );
    await writeFile(path, JSON.stringify(info), { mode: 0o600 });
    await assert.rejects(
      discoverPreviewHost(path, async () => {
        throw Error("PRIVATE_TOKEN_AND_PATH");
      }),
      (error) =>
        error instanceof DaemonDiscoveryError &&
        error.category === "unavailable" &&
        !error.message.includes("PRIVATE"),
    );
    for (const count of [0, 2]) {
      let calls = 0;
      await assert.rejects(
        discoverPreviewHost(path, async () => {
          if (++calls === 1) return reply({ ...info, ok: true });
          return reply({
            version: 1,
            servers: Array.from({ length: count }, () => ({
              serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
              generation: randomUUID(),
              label: "PRIVATE_LABEL",
              state: "online",
            })),
          });
        }),
        (error) => {
          assert.ok(error instanceof DaemonDiscoveryError);
          assert.equal(error.category, count === 0 ? "no-server" : "multiple-servers");
          assert.ok(Buffer.byteLength(error.message) <= 256);
          assert.ok(!error.message.includes("PRIVATE"));
          return true;
        },
      );
    }
  });
});

test("all public discovery guidance fits the native status limit", () => {
  for (const category of [
    "no-daemon",
    "unavailable",
    "no-server",
    "multiple-servers",
    "identity-changed",
    "record-changed",
  ] as const) {
    const error = new DaemonDiscoveryError(category);
    assert.ok(error.message.length > 0 && Buffer.byteLength(error.message) <= 240);
    assert.ok(!error.message.includes("undefined"));
  }
});
