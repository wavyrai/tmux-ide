import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AutomationOperationIntent } from "@tmux-ide/contracts";
import { mountAutomationRoutes } from "./automation.ts";
import { InteractionEvidenceAuthority } from "../lib/interaction-evidence-authority.ts";
import { AutomationOperationRegistry } from "../lib/automation-operation-registry.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import type { TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import { PANE_SOURCE_CREDENTIAL_HEADER } from "../lib/pane-source-credentials.ts";
const base = "/api/v1/automation";
function fixture(options: { capacity?: number; retentionMs?: number } = {}) {
  let now = 0;
  const operations = new AutomationOperationRegistry<
    import("@tmux-ide/contracts").AutomationOperationSummary
  >({ ...options, now: () => now });
  const records = [0, 1].map((index) => {
    const scope = { serverId: `tmux-server.${String(index).repeat(32)}`, generation: randomUUID() };
    const evidence = new InteractionEvidenceAuthority(
      "00000000-0000-4000-8000-000000000001",
      scope,
    );
    const rows = [
      {
        workspaceName: "shared",
        sessionName: "shared",
        sessionId: "$0",
        runtimePaneId: "%0",
        semanticPaneId: "pane.shared",
      },
    ];
    evidence.adoptInventory(rows);
    const endpoint = evidence.captureAuthoredEndpoint("shared", "pane.shared")!;
    let current = true,
      credential = `secret${index}`;
    const bindingId = randomUUID();
    const submit = vi.fn(
      async (
        operationId: string,
        intent: { verb: string; submit?: boolean },
        authority: { authorizeBeforeEffect: () => void },
      ) => {
        authority.authorizeBeforeEffect();
        const envelope = {
          operationId,
          daemonInstanceId: scope.generation,
          workspaceName: "shared",
          semanticPaneId: "pane.shared",
        };
        return intent.verb === "workspace.pane.read"
          ? {
              ...envelope,
              verb: intent.verb,
              format: "ansi",
              availability: "available",
              text: "private snapshot\n",
              byteCount: 17,
              capturedByteCount: 17,
              truncated: false,
            }
          : {
              ...envelope,
              verb: intent.verb,
              outcome: "applied",
              origin: "sdk",
              sourceSemanticPaneId: null,
              characterCount: 5,
              byteCount: 5,
              submitted: intent.submit,
            };
      },
    );
    const owner = {
      generation: scope.generation,
      interactionEvidence: evidence,
      catalog: vi.fn(async () => []),
      terminalInventoryRuntime: {
        discoverTerminalInventory: vi.fn(async () => ({
          panes: rows.map((row) => ({ ...row, title: "\x1b[31mAgent\x1b[0m\n" })),
        })),
      },
      resolveInteractionSource: vi.fn((token: string, workspace: string, pane: string) =>
        current && token === credential && workspace === "shared" && pane === "pane.shared"
          ? { endpoint, bindingId }
          : null,
      ),
      submitAutomationIntent: submit,
    } as unknown as NativeTmuxServerOwner;
    return {
      owner,
      scope,
      endpoint,
      submit,
      evidence,
      retire: () => {
        current = false;
        evidence.dispose();
      },
      valid: () => current,
      rotate: () => {
        credential += "new";
      },
    };
  });
  const current = (scope: { serverId: string; generation: string }) => {
    const record = records.find(
      (record) =>
        record.valid() &&
        record.scope.serverId === scope.serverId &&
        record.scope.generation === scope.generation,
    );
    if (!record) throw new Error("retired");
    return record.owner;
  };
  const owners = {
    current,
    observe: async () =>
      records
        .filter((record) => record.valid())
        .map((record) => ({ ...record.scope, state: "online" })),
    withOwner: async (
      scope: { serverId: string; generation: string },
      work: (owner: NativeTmuxServerOwner) => unknown,
    ) => work(current(scope)),
  } as unknown as TmuxServerOwners<NativeTmuxServerOwner>;
  const app = new Hono();
  mountAutomationRoutes(app, { ownerToken: "owner", owners, operations });
  const request = (path: string, body?: unknown, token = "owner", credential?: string) =>
    app.request(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(credential ? { [PANE_SOURCE_CREDENTIAL_HEADER]: credential } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const intent: AutomationOperationIntent = {
    kind: "send",
    target: records[0]!.endpoint,
    source: null,
    text: "hello",
    enter: true,
  };
  const reserve = async (value = intent, credential?: string) => {
    const response = await request("/reserve", { version: 1, intent: value }, "owner", credential);
    expect(response.status).toBe(201);
    return (await response.json()).handle;
  };
  return {
    app,
    records,
    operations,
    request,
    intent,
    reserve,
    advance: (value: number) => {
      now += value;
    },
  };
}
describe("daemon automation routes", () => {
  it.each(
    (["cli", "sdk", "mcp"] as const).flatMap((origin) =>
      (["read", "send"] as const).map((kind) => ({ origin, kind })),
    ),
  )(
    "preserves $origin $kind adapter origin and binds it to the handle",
    async ({ origin, kind }) => {
      const f = fixture();
      const intent = kind === "read" ? { kind, target: f.intent.target, source: null } : f.intent;
      const reserved = await f.request("/reserve", { version: 1, intent, origin });
      expect(reserved.status).toBe(201);
      const { handle } = await reserved.json();
      const body = { version: 1, handle, intent, origin };
      const changed = await f.request("/execute", {
        ...body,
        origin: origin === "mcp" ? "sdk" : "mcp",
      });
      expect(changed.status).not.toBe(200);
      expect(f.records[0]!.submit).not.toHaveBeenCalled();
      expect((await f.request("/execute", body)).status).toBe(200);
      expect((await f.request("/execute", body)).status).toBe(200);
      expect(f.records[0]!.submit).toHaveBeenCalledExactlyOnceWith(
        handle.operationId,
        expect.objectContaining({ origin }),
        expect.objectContaining({ origin, source: null }),
      );
    },
  );
  it("requires owner auth on every operation and exposes bounded meaningful pane descriptors", async () => {
    const f = fixture();
    for (const [path, body] of [
      ["/panes", undefined],
      ["/reserve", {}],
      ["/execute", {}],
      [`/operations/${randomUUID()}/${randomUUID()}`, undefined],
    ] as const)
      expect((await f.request(path, body, "foreign")).status).toBe(401);
    const body = await (await f.request("/panes")).json();
    expect(body.panes).toHaveLength(2);
    expect(body.panes[0]).toEqual({
      endpoint: f.records[0]!.endpoint,
      title: "Agent",
      sessionName: "shared",
    });
    expect(JSON.stringify(body)).not.toMatch(/runtimePaneId|socket|private/);
  });
  it("executes one daemon-minted handle once and exposes content-free status", async () => {
    const f = fixture();
    const handle = await f.reserve();
    const body = { version: 1, handle, intent: f.intent };
    const responses = await Promise.all([f.request("/execute", body), f.request("/execute", body)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(f.records[0]!.submit).toHaveBeenCalledTimes(1);
    const status = await (
      await f.request(`/operations/${handle.generation}/${handle.operationId}`)
    ).json();
    expect(status.status).toBe("completed");
    expect(status.result).toEqual({ kind: "send", submitted: true });
    expect(JSON.stringify(status)).not.toContain("hello");
  });
  it("returns the single captured snapshot only to first read, never pending or settled replays", async () => {
    const f = fixture();
    const intent = { kind: "read" as const, target: f.intent.target, source: null };
    const handle = await f.reserve(intent);
    const body = { version: 1, handle, intent };
    const original = f.records[0]!.submit.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.records[0]!.submit.mockImplementationOnce(async (...args) => {
      await gate;
      return original(...args);
    });
    const pending = f.request("/execute", body);
    await vi.waitFor(() => expect(f.records[0]!.submit).toHaveBeenCalledTimes(1));
    const pendingReplay = f.request("/execute", body);
    release();
    const first = await (await pending).json();
    const concurrent = await (await pendingReplay).json();
    expect(concurrent.read).toEqual({ availability: "replay-unavailable", text: null });
    const replay = await (await f.request("/execute", body)).json();
    expect(first.read).toEqual({ availability: "available", text: "private snapshot\n" });
    expect(replay.read).toEqual({ availability: "replay-unavailable", text: null });
    expect(f.records[0]!.submit).toHaveBeenCalledTimes(1);
    const status = await (
      await f.request(`/operations/${handle.generation}/${handle.operationId}`)
    ).json();
    expect(JSON.stringify(status)).not.toContain("private");
    expect(status.result.returnedBytes).toBe(17);
  });
  it("rejects same-handle different intent and arbitrary/expired handles without effects", async () => {
    const f = fixture({ retentionMs: 10 });
    const handle = await f.reserve();
    const changed = await f.request("/execute", {
      version: 1,
      handle,
      intent: { ...f.intent, text: "other" },
    });
    expect(changed.status).toBe(409);
    f.advance(11);
    for (const unavailable of [handle, { generation: randomUUID(), operationId: randomUUID() }]) {
      expect(
        (await f.request("/execute", { version: 1, handle: unavailable, intent: f.intent })).status,
      ).toBe(409);
      expect(
        (
          await (
            await f.request(`/operations/${unavailable.generation}/${unavailable.operationId}`)
          ).json()
        ).status,
      ).toBe("outcome-unknown");
    }
    expect(f.records[0]!.submit).not.toHaveBeenCalled();
  });
  it("binds a cross-server source capability without passing a foreign pane hint", async () => {
    const f = fixture();
    const intent = { ...f.intent, source: f.records[1]!.endpoint };
    const handle = await f.reserve(intent, "secret1");
    expect(
      (await f.request("/execute", { version: 1, handle, intent }, "owner", "secret1")).status,
    ).toBe(200);
    const call = f.records[0]!.submit.mock.calls[0]!;
    expect(call[1]).not.toHaveProperty("sourceSemanticPaneId");
    expect(call[2]).toMatchObject({ source: { endpoint: f.records[1]!.endpoint } });
  });
  it("rejects missing, wrong-server and rotated source credentials", async () => {
    const f = fixture();
    const intent = { ...f.intent, source: f.records[1]!.endpoint };
    for (const token of [undefined, "secret0"])
      expect((await f.request("/reserve", { version: 1, intent }, "owner", token)).status).toBe(
        409,
      );
    const handle = await f.reserve(intent, "secret1");
    f.records[1]!.rotate();
    expect(
      (await f.request("/execute", { version: 1, handle, intent }, "owner", "secret1")).status,
    ).toBe(409);
    expect(f.records[0]!.submit).not.toHaveBeenCalled();
  });
  it.each(["environmentId", "paneLifetimeId", "workspaceName", "semanticPaneId"])(
    "rejects a foreign target %s",
    async (field) => {
      const f = fixture();
      const target = {
        ...f.intent.target,
        [field]: field.endsWith("Id") && field !== "semanticPaneId" ? randomUUID() : "foreign",
      };
      expect(
        (await f.request("/reserve", { version: 1, intent: { ...f.intent, target } })).status,
      ).toBe(409);
      expect(f.records[0]!.submit).not.toHaveBeenCalled();
    },
  );
  it("revalidates source immediately before queued effect and retains uncertainty without retry", async () => {
    const f = fixture();
    const intent = { ...f.intent, source: f.records[1]!.endpoint };
    const handle = await f.reserve(intent, "secret1");
    f.records[0]!.submit.mockImplementationOnce(async (_id, _intent, authority) => {
      f.records[1]!.retire();
      authority.authorizeBeforeEffect();
      throw new Error("private stderr");
    });
    expect(
      (await f.request("/execute", { version: 1, handle, intent }, "owner", "secret1")).status,
    ).toBe(409);
    const status = await (
      await f.request(`/operations/${handle.generation}/${handle.operationId}`)
    ).json();
    expect(status.status).toBe("outcome-unknown");
    expect(JSON.stringify(status)).not.toContain("private");
  });
  it("never repeats a failed effect or retains private failure text", async () => {
    const f = fixture();
    const handle = await f.reserve();
    f.records[0]!.submit.mockRejectedValue(new Error("private stderr with terminal data"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.request("/execute", { version: 1, handle, intent: f.intent });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "operation-unavailable" } });
    }
    expect(f.records[0]!.submit).toHaveBeenCalledTimes(1);
  });
  it("bounds request bytes/input and reservation count before effects", async () => {
    const f = fixture({ capacity: 1 });
    await f.reserve();
    expect((await f.request("/reserve", { version: 1, intent: f.intent })).status).toBe(429);
    expect(
      (await f.request("/reserve", { version: 1, intent: { ...f.intent, text: "é".repeat(9000) } }))
        .status,
    ).toBe(400);
    expect((await f.request("/reserve", { padding: "x".repeat(128 * 1024) })).status).toBe(400);
    expect(f.records[0]!.submit).not.toHaveBeenCalled();
  });
});

it("discovers the verified invoking source across servers and rejects stale credentials", async () => {
  const f = fixture();
  const unknown = await (await f.request("/panes")).json();
  expect(unknown.source).toBeNull();
  const source = f.records[1]!;
  const response = await f.request("/panes", undefined, "owner", "secret1");
  expect(response.status).toBe(200);
  expect((await response.json()).source).toEqual(source.endpoint);
  const stale = await f.request("/panes", undefined, "owner", "stale");
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: { code: "invalid-source" } });
});
