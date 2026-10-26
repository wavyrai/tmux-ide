import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../../../packages/contracts/src/index.ts";
import { discoverPreviewHost, localPreviewHostProof } from "./discovery.ts";
import { issueDirectTerminal } from "./direct-terminal.ts";

const config = {
  baseUrl: "http://127.0.0.1:41234/",
  ownerToken: "private-owner-token-sentinel",
  scope: {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "12d14eac-0000-4000-8000-000000000001",
  },
  workspaceName: "project",
  liveSessionId: `live-session.${"b".repeat(20)}`,
  semanticPaneId: "pane.one",
  visiblePaneIds: ["pane.one", "pane.two"],
};
const scopedPath = `/v2/tmux-servers/${config.scope.serverId}/${config.scope.generation}/pane-streams/redeem`;
function issued(init?: RequestInit) {
  const body = JSON.parse(String(init?.body));
  return {
    status: "issued",
    descriptor: {
      protocolVersion: 2,
      webSocketUrl: `ws://127.0.0.1:41234${scopedPath}`,
      subprotocol: "tmux-ide-pane-stream.v2",
      redemptionTicket: `ps2_${"a".repeat(43)}`,
      daemonInstanceId: config.scope.generation,
      requestId: body.requestId,
      expiresAt: Date.now() + 30_000,
      panes: body.stream.panes,
      effectiveViewerMode: body.stream.viewerMode,
    },
  };
}
function fetcher(handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return handler as typeof fetch;
}

test("direct broker issues one scoped binary-opt-in capability with a compact-compatible offer and keeps owner credential out of handoff", async () => {
  let calls = 0;
  let hostId = "";
  const result = await issueDirectTerminal(
    config,
    "interactive",
    new AbortController().signal,
    fetcher(async (url, init) => {
      calls++;
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, new URL(config.baseUrl).origin);
      assert.equal(
        parsed.pathname,
        `/api/v1/tmux-servers/${config.scope.serverId}/${config.scope.generation}/pane-streams/issue`,
      );
      assert.equal(parsed.searchParams.get("liveSessionId"), config.liveSessionId);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${config.ownerToken}`);
      assert.equal(headers.get("Origin"), "tmux-ide://app");
      hostId = headers.get("X-Tmux-Ide-Host-Client-Id")!;
      assert.match(hostId, /^gpui:[0-9a-f-]{36}$/);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.expectedDaemonInstanceId, config.scope.generation);
      assert.equal(body.requestId, headers.get("X-Tmux-Ide-Request-Id"));
      assert.deepEqual(body.stream, {
        protocolVersion: 2,
        workspaceName: config.workspaceName,
        panes: config.visiblePaneIds,
        viewerMode: "interactive",
        terminalDelivery: {
          protocolVersions: [1, 101, 113, 102, 103, 104, 105, 106],
          encodings: ["semantic-compact-v1"],
          richPlacements: true,
        },
      });
      return Response.json(issued(init));
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.hostClientId, hostId);
  assert.equal(result.selectedPane, config.semanticPaneId);
  assert.equal(result.workspaceName, config.workspaceName);
  assert.equal(result.graphics, true);
  assert.equal(result.binaryCells, true);
  assert.equal(result.alternateScreenProjection, true);
  assert.deepEqual(result.serverScope, config.scope);
  assert.deepEqual(Object.keys(result).sort(), [
    "alternateScreenProjection",
    "binaryCells",
    "descriptor",
    "graphics",
    "hostClientId",
    "origin",
    "selectedPane",
    "serverScope",
    "workspaceName",
  ]);
  assert.ok(!JSON.stringify(result).includes(config.ownerToken));
  assert.ok(!JSON.stringify(result).includes("ownerToken"));
  assert.equal(result.descriptor.webSocketUrl, `ws://127.0.0.1:41234${scopedPath}`);
});

test("read-only capability does not advertise input lifetime and defaults to the selected pane", async () => {
  const one = { ...config, visiblePaneIds: undefined };
  await issueDirectTerminal(
    one,
    "read-only",
    new AbortController().signal,
    fetcher(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.stream.panes, [config.semanticPaneId]);
      assert.deepEqual(body.stream.terminalDelivery.protocolVersions, [1, 101, 113, 102, 103, 104]);
      assert.equal(body.stream.viewerMode, "read-only");
      return Response.json(issued(init));
    }),
  );
});

test("pre-aborted or invalid pane set never issues a capability", async () => {
  let calls = 0;
  const unexpected = fetcher(async () => {
    calls++;
    throw new Error("unexpected request");
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(issueDirectTerminal(config, "interactive", abort.signal, unexpected), {
    name: "AbortError",
  });
  for (const visiblePaneIds of [["pane.two"], ["pane.one", "pane.one"]]) {
    await assert.rejects(
      issueDirectTerminal(
        { ...config, visiblePaneIds },
        "interactive",
        new AbortController().signal,
        unexpected,
      ),
      /Invalid native terminal pane set/,
    );
  }
  assert.equal(calls, 0);
});

test("in-flight cancellation reaches fetch and does not replay issuance", async () => {
  const abort = new AbortController();
  let calls = 0;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = issueDirectTerminal(
    config,
    "interactive",
    abort.signal,
    fetcher(async (_url, init) => {
      calls++;
      assert.ok(init?.signal);
      started();
      return new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
      );
    }),
  );
  await requestStarted;
  abort.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("late successful issue after cancellation cannot escape as a usable handoff", async () => {
  const abort = new AbortController();
  await assert.rejects(
    issueDirectTerminal(
      config,
      "interactive",
      abort.signal,
      fetcher(async (_url, init) => {
        abort.abort();
        return Response.json(issued(init));
      }),
    ),
    { name: "AbortError" },
  );
});

test("refusal and viewer-mode downgrade stop without fallback issuance", async () => {
  for (const refusal of [true, false]) {
    let calls = 0;
    await assert.rejects(
      issueDirectTerminal(
        config,
        "interactive",
        new AbortController().signal,
        fetcher(async (_url, init) => {
          calls++;
          if (refusal)
            return Response.json({
              status: "error",
              error: {
                code: "interactive-viewer-conflict",
                reason: "Another viewer owns input",
                retryable: false,
              },
            });
          const response = issued(init);
          response.descriptor.effectiveViewerMode = "read-only";
          return Response.json(response);
        }),
      ),
      /Native terminal capability refused/,
    );
    assert.equal(calls, 1);
  }
});

test("SSH handoff rewrites only the verified remote origin to the local forward", async () => {
  const remoteSocketOrigin = "ws://127.0.0.1:49999";
  const result = await issueDirectTerminal(
    { ...config, remoteSocketOrigin },
    "interactive",
    new AbortController().signal,
    fetcher(async (_url, init) => {
      const response = issued(init);
      response.descriptor.webSocketUrl = `${remoteSocketOrigin}${scopedPath}`;
      return Response.json(response);
    }),
  );
  assert.equal(result.descriptor.webSocketUrl, `ws://127.0.0.1:41234${scopedPath}`);
  await assert.rejects(
    issueDirectTerminal(
      { ...config, remoteSocketOrigin },
      "interactive",
      new AbortController().signal,
      fetcher(async (_url, init) => Response.json(issued(init))),
    ),
    /verified daemon origin/,
  );
});

test("issued response must echo exact request, generation and pane identities", async () => {
  for (const mutation of ["request", "generation", "pane"]) {
    await assert.rejects(
      issueDirectTerminal(
        config,
        "interactive",
        new AbortController().signal,
        fetcher(async (_url, init) => {
          const response = issued(init);
          if (mutation === "request")
            response.descriptor.requestId = "12d14eac-0000-4000-8000-000000000002";
          if (mutation === "generation")
            response.descriptor.daemonInstanceId = "12d14eac-0000-4000-8000-000000000002";
          if (mutation === "pane") response.descriptor.panes = ["pane.other"];
          return Response.json(response);
        }),
      ),
      { code: "scope-mismatch" },
    );
  }
});

test("unknown descriptor fields cannot smuggle owner credentials into handoff", async () => {
  await assert.rejects(
    issueDirectTerminal(
      config,
      "interactive",
      new AbortController().signal,
      fetcher(async (_url, init) =>
        Response.json({
          ...issued(init),
          descriptor: { ...issued(init).descriptor, ownerToken: config.ownerToken },
        }),
      ),
    ),
  );
});

test("local images require live canonical provenance and never infer locality from loopback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "direct-local-images-"));
  const path = join(dir, "daemon.json");
  const info = {
    pid: process.pid,
    port: 41234,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "2.9.10",
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    bindHostname: "127.0.0.1",
    authToken: config.ownerToken,
  };
  let identity = info;
  try {
    await writeFile(path, JSON.stringify(info), { mode: 0o600 });
    const host = await discoverPreviewHost(
      path,
      fetcher(async (url) =>
        String(url).endsWith("/identity")
          ? Response.json({ ...identity, ok: true })
          : Response.json({
              version: 1,
              servers: [{ ...config.scope, label: "local", state: "online" }],
            }),
      ),
    );
    const proof = localPreviewHostProof(host)!;
    let calls = 0;
    const issue = fetcher(async (_url, init) => {
      calls++;
      const offered = JSON.parse(String(init?.body)).stream.terminalDelivery.protocolVersions;
      assert.equal(offered.includes(114), process.platform !== "win32");
      assert.equal(offered.includes(111), process.platform === "win32");
      assert.equal(offered.length, 8);
      return Response.json(issued(init));
    });
    const result = await issueDirectTerminal(
      { ...config, ...host },
      "interactive",
      new AbortController().signal,
      issue,
      proof,
    );
    assert.deepEqual(
      result.localImages,
      process.platform === "win32"
        ? undefined
        : {
            root: join(realpathSync(dir), `local-images-${info.instanceId}`),
            generation: info.instanceId,
          },
    );
    assert.notEqual(info.instanceId, config.scope.generation);
    const forged = await issueDirectTerminal(
      { ...config, ...host },
      "interactive",
      new AbortController().signal,
      fetcher(async (_url, init) => {
        assert.equal(
          JSON.parse(String(init?.body)).stream.terminalDelivery.protocolVersions.includes(114),
          false,
        );
        return Response.json(issued(init));
      }),
      { ...proof },
    );
    assert.equal(forged.localImages, undefined);
    if (process.platform !== "win32") {
      identity = { ...info, instanceId: randomUUID() };
      await assert.rejects(
        issueDirectTerminal(
          { ...config, ...host },
          "interactive",
          new AbortController().signal,
          issue,
          proof,
        ),
      );
      assert.equal(calls, 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
