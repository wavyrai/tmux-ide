import { describe, expect, it, vi } from "vitest";
import type { CausalCellProbeV1 } from "@tmux-ide/contracts";
import type { SessionRuntimeConsumer } from "./registry.ts";
import { SessionRuntimeRegistry } from "./registry.ts";
import { SessionRuntimeTransportBinder } from "./transport-binding.ts";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const LEASE = {
  generation: GENERATION,
  session: "alpha",
  clientId: "electron:renderer-a",
  token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  revision: 1,
} as const;
const OP_A = "00000000-0000-4000-8000-000000000011";
const OP_B = "00000000-0000-4000-8000-000000000012";
const OP_C = "00000000-0000-4000-8000-000000000013";

function sendIntent() {
  return {
    verb: "workspace.pane.send" as const,
    workspaceName: "alpha",
    semanticPaneId: "pane.tests",
    text: "run tests",
    submit: true,
    origin: "gui" as const,
  };
}

function sendResult(operationId: string, intent: ReturnType<typeof sendIntent>) {
  return {
    operationId,
    daemonInstanceId: GENERATION,
    workspaceName: intent.workspaceName,
    verb: intent.verb,
    outcome: "applied" as const,
    sourceSemanticPaneId: null,
    semanticPaneId: intent.semanticPaneId,
    origin: intent.origin,
    characterCount: 9,
    byteCount: 9,
    submitted: intent.submit,
  };
}

describe("SessionRuntimeTransportBinder", () => {
  it("keeps a same-host pane authorized when its sibling pane stream closes", async () => {
    const registry = new SessionRuntimeRegistry({
      generation: GENERATION,
      createControllerToken: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const binder = new SessionRuntimeTransportBinder(registry);
    const paneA = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000071",
      session: "alpha",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.a"],
      interactive: true,
      ownsGeometry: true,
      explicitAuthority: true,
    });
    const paneB = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000072",
      session: "alpha",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.b"],
      interactive: true,
      ownsGeometry: true,
      explicitAuthority: true,
    });

    expect(paneB.requestAuthority("input")?.clientId).toBe("web:document-a");
    expect(paneB.requestAuthority("geometry")?.clientId).toBe("web:document-a");
    await paneA.close();

    expect(paneB.authoritySnapshot().owners).toMatchObject({
      input: "web:document-a",
      geometry: "web:document-a",
    });
    paneB.assertController("pane.b");
    expect(paneB.requestAuthority("geometry")?.clientId).toBe("web:document-a");
    await paneB.close();
    await registry.dispose();
  });

  it("lets explicit multi-client authority hand off independently without admission conflicts", async () => {
    const tokens = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ];
    const registry = new SessionRuntimeRegistry({
      generation: GENERATION,
      createControllerToken: () => tokens.shift()!,
    });
    const binder = new SessionRuntimeTransportBinder(registry);
    const first = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000081",
      session: "alpha",
      hostClientId: "web:first",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
      ownsGeometry: true,
      explicitAuthority: true,
    });
    const second = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000082",
      session: "alpha",
      hostClientId: "opentui:second",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
      ownsGeometry: true,
      explicitAuthority: true,
    });
    const publishedOwners: Array<string | null> = [];
    const stopSnapshots = first.onAuthoritySnapshot((snapshot) => {
      publishedOwners.push(snapshot.owners.input);
      if (snapshot.owners.input === "web:first") first.assertController("pane.editor");
      if (snapshot.owners.input === "opentui:second") second.assertController("pane.editor");
    });

    second.updatePresence("foreground");
    expect(second.requestAuthority("input")?.clientId).toBe("opentui:second");
    first.updatePresence("foreground");
    expect(first.requestAuthority("input")?.clientId).toBe("web:first");
    expect(first.requestAuthority("geometry")?.clientId).toBe("web:first");

    // Both clients retain claims, but ambient presence/activity is not allowed
    // to move executable input authority behind the controller seam's back.
    second.updatePresence("background");
    second.updatePresence("foreground");
    second.noteActivity("input");
    expect(first.authoritySnapshot().owners.input).toBe("web:first");
    first.assertController("pane.editor");

    // An explicit acquire performs the controller handoff before publishing
    // B as owner; from this point A's old execution proof is stale.
    expect(second.requestAuthority("input")?.clientId).toBe("opentui:second");
    expect(second.authoritySnapshot().owners).toMatchObject({ input: "opentui:second" });
    expect(() => first.assertController("pane.editor")).toThrowError(
      expect.objectContaining({ code: "stale-controller-lease" }),
    );
    second.assertController("pane.editor");

    await second.close();
    expect(first.requestAuthority("input")?.clientId).toBe("web:first");
    first.assertController("pane.editor");
    expect(publishedOwners).toContain("web:first");
    expect(publishedOwners).toContain("opentui:second");
    stopSnapshots();
    await first.close();
    await registry.dispose();
  });

  it("never promotes a passive cross-transport pane into an authorship grant", async () => {
    const registry = new SessionRuntimeRegistry({
      generation: GENERATION,
      createControllerToken: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const binder = new SessionRuntimeTransportBinder(registry);
    const interactive = binder.bind({
      transport: "terminal-attachment",
      transportLeaseId: "00000000-0000-4000-8000-000000000001",
      session: "alpha",
      hostClientId: "host:shared",
      allowedSourcePaneIds: ["pane.a"],
      interactive: true,
    });
    const passive = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000002",
      session: "alpha",
      hostClientId: "host:shared",
      allowedSourcePaneIds: ["pane.b"],
      interactive: false,
    });
    expect(binder.resolveExecutionHandle("alpha", "host:shared", "pane.a")).toBeTruthy();
    expect(binder.resolveExecutionHandle("alpha", "host:shared", "pane.b")).toBeUndefined();
    expect(() => interactive.handoffController(passive)).toThrow(
      "Cannot hand controller authority to a passive transport",
    );
    interactive.assertController("pane.a");
    await Promise.all([passive.close(), interactive.close()]);
    await registry.dispose();
  });

  it("serializes distinct trusted hosts at controller admission and enforces exact pane grants", async () => {
    const tokens = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
    const registry = new SessionRuntimeRegistry({
      generation: GENERATION,
      createControllerToken: () => tokens.shift()!,
    });
    const binder = new SessionRuntimeTransportBinder(registry);
    const first = binder.bind({
      transport: "terminal-attachment",
      transportLeaseId: "00000000-0000-4000-8000-000000000001",
      session: "alpha",
      hostClientId: "electron:renderer-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
    });

    expect(() => first.assertController("pane.tests")).toThrowError(
      expect.objectContaining({ code: "invalid-source-pane-binding" }),
    );
    expect(() =>
      binder.bind({
        transport: "pane-stream",
        transportLeaseId: "00000000-0000-4000-8000-000000000002",
        session: "alpha",
        hostClientId: "electron:renderer-b",
        allowedSourcePaneIds: ["pane.editor", "pane.tests"],
        interactive: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "controller-conflict" }));

    await first.close();
    const second = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000003",
      session: "alpha",
      hostClientId: "electron:renderer-b",
      allowedSourcePaneIds: ["pane.tests"],
      interactive: true,
    });
    second.assertController("pane.tests");
    await second.close();
    await registry.dispose();
  });

  it("shares stable host authority across transports and keeps proof opaque", async () => {
    const close = vi.fn(async () => undefined);
    const consumer = {
      generation: GENERATION,
      session: "alpha",
      surface: "pane-stream",
      clientId: "electron:renderer-a",
      acquireController: vi.fn(() => LEASE),
      releaseController: vi.fn(),
      fitViewport: vi.fn(),
      close,
    } as unknown as SessionRuntimeConsumer;
    const baseHandle = Object.freeze(Object.create(null)) as object;
    const sourceHandle = Object.freeze(Object.create(null)) as object;
    const registry = {
      generation: GENERATION,
      connect: vi.fn(() => consumer),
      createExecutionHandle: vi.fn(() => baseHandle),
      bindExecutionSource: vi.fn(() => sourceHandle),
      assertExecutionHandle: vi.fn(),
    };
    const binder = new SessionRuntimeTransportBinder(registry);
    const first = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000001",
      session: "alpha",
      hostClientId: "electron:renderer-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
      ownsGeometry: true,
    });
    const sibling = binder.bind({
      transport: "terminal-attachment",
      transportLeaseId: "00000000-0000-4000-8000-000000000002",
      session: "alpha",
      hostClientId: "electron:renderer-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
      ownsGeometry: true,
    });

    expect(registry.connect).toHaveBeenCalledOnce();
    expect(consumer.acquireController).toHaveBeenCalledOnce();
    first.assertController("pane.editor");
    expect(first.executionHandleForSource("pane.editor")).toBe(sourceHandle);
    expect(Object.keys(baseHandle)).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(LEASE.token);
    await first.close();
    expect(close).not.toHaveBeenCalled();
    await sibling.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps overlapping same-host reconnect delivery lifecycles independent", async () => {
    const deliveryCloses = new Map<string, ReturnType<typeof vi.fn>>();
    const consumer = {
      generation: GENERATION,
      session: "alpha",
      surface: "pane-stream",
      clientId: "web:document-a",
      acquireController: vi.fn(() => LEASE),
      releaseController: vi.fn(),
      fitViewport: vi.fn(),
      close: vi.fn(async () => undefined),
      openTerminalDelivery: vi.fn(
        async (subscriberId: string, _paneId: string, _offer: unknown, _accept: unknown) => {
          const close = vi.fn(async () => undefined);
          deliveryCloses.set(subscriberId, close);
          return {
            negotiation: {
              accepted: true,
              negotiated: {
                protocolVersion: 1,
                encoding: "semantic-v1",
                richPlacements: false,
                generation: GENERATION,
                deliveryNonce: "00000000-0000-4000-8000-000000000099",
              },
            },
            ack: vi.fn(),
            nack: vi.fn(),
            setVisibility: vi.fn(),
            close,
          };
        },
      ),
    } as unknown as SessionRuntimeConsumer;
    const handle = Object.freeze(Object.create(null)) as object;
    const registry = {
      generation: GENERATION,
      connect: vi.fn(() => consumer),
      createExecutionHandle: vi.fn(() => handle),
      bindExecutionSource: vi.fn(() => handle),
      assertExecutionHandle: vi.fn(),
      submitAuthenticatedIntent: vi.fn(),
    };
    const binder = new SessionRuntimeTransportBinder(registry);
    const firstLeaseId = "00000000-0000-4000-8000-000000000001";
    const secondLeaseId = "00000000-0000-4000-8000-000000000002";
    const first = binder.bind({
      transport: "pane-stream",
      transportLeaseId: firstLeaseId,
      session: "alpha",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
      ownsGeometry: true,
    });
    const replacement = binder.bind({
      transport: "pane-stream",
      transportLeaseId: secondLeaseId,
      session: "alpha",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
      ownsGeometry: true,
    });
    const offer = {
      protocolVersions: [1],
      encodings: ["semantic-v1"],
      richPlacements: false,
    } as const;
    const oldDelivery = await first.openTerminalDelivery("pane.editor", offer, vi.fn());
    const newDelivery = await replacement.openTerminalDelivery("pane.editor", offer, vi.fn());

    const subscriberIds = consumer.openTerminalDelivery.mock.calls.map((call) => call[0]);
    expect(subscriberIds).toEqual([
      `web:document-a:${firstLeaseId}`,
      `web:document-a:${secondLeaseId}`,
    ]);
    await oldDelivery.close();
    expect(() => first.fitViewport(120, 40)).toThrowError(
      expect.objectContaining({ code: "invalid-client-capability" }),
    );
    replacement.fitViewport(132, 44);
    expect(consumer.fitViewport).toHaveBeenCalledWith(LEASE, 132, 44);
    await first.close();
    expect(deliveryCloses.get(subscriberIds[0]!)).toHaveBeenCalledOnce();
    expect(deliveryCloses.get(subscriberIds[1]!)).not.toHaveBeenCalled();
    replacement.assertController("pane.editor");

    await newDelivery.close();
    await replacement.close();
    expect(deliveryCloses.get(subscriberIds[1]!)).toHaveBeenCalledOnce();
  });

  it("fails only the closing transport binding's active causal probe immediately", async () => {
    const failCausalCellProbe = vi.fn();
    const consumer = {
      generation: GENERATION,
      session: "alpha",
      surface: "pane-stream",
      clientId: "web:document-a",
      acquireController: vi.fn(() => LEASE),
      releaseController: vi.fn(),
      sendInput: vi.fn(),
      failCausalCellProbe,
      close: vi.fn(async () => undefined),
    } as unknown as SessionRuntimeConsumer;
    const handle = Object.freeze(Object.create(null)) as object;
    const registry = {
      generation: GENERATION,
      connect: vi.fn(() => consumer),
      createExecutionHandle: vi.fn(() => handle),
      bindExecutionSource: vi.fn(() => handle),
      assertExecutionHandle: vi.fn(),
      submitAuthenticatedIntent: vi.fn(),
    };
    const binder = new SessionRuntimeTransportBinder(registry);
    const owner = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000001",
      session: "alpha",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
    });
    const sibling = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000002",
      session: "alpha",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
    });
    const probe = { traceId: OP_A } as unknown as CausalCellProbeV1;
    owner.sendInput("pane.editor", { kind: "text", data: "x" }, OP_A, probe, vi.fn());

    await sibling.close();
    expect(failCausalCellProbe).not.toHaveBeenCalled();
    await owner.close();
    expect(failCausalCellProbe).toHaveBeenCalledOnce();
    expect(failCausalCellProbe).toHaveBeenCalledWith("pane.editor", OP_A, "transport-closed");
  });

  it("restores geometry authority to an older live same-host transport when its replacement closes", async () => {
    const consumer = {
      generation: GENERATION,
      session: "alpha",
      surface: "pane-stream",
      clientId: "web:document-a",
      acquireController: vi.fn(() => LEASE),
      releaseController: vi.fn(),
      fitViewport: vi.fn(),
      close: vi.fn(async () => undefined),
    } as unknown as SessionRuntimeConsumer;
    const handle = Object.freeze(Object.create(null)) as object;
    const registry = {
      generation: GENERATION,
      connect: vi.fn(() => consumer),
      createExecutionHandle: vi.fn(() => handle),
      bindExecutionSource: vi.fn(() => handle),
      assertExecutionHandle: vi.fn(),
      submitAuthenticatedIntent: vi.fn(),
    };
    const binder = new SessionRuntimeTransportBinder(registry);
    const first = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000001",
      session: "alpha",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
      ownsGeometry: true,
    });
    const replacement = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000002",
      session: "alpha",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
      ownsGeometry: true,
    });

    expect(() => first.fitViewport(120, 40)).toThrowError(
      expect.objectContaining({ code: "invalid-client-capability" }),
    );
    replacement.fitViewport(132, 44);
    await replacement.close();
    first.fitViewport(120, 40);
    expect(consumer.fitViewport).toHaveBeenLastCalledWith(LEASE, 120, 40);

    await first.close();
  });

  it("retains session authority but no source grant across an interactive retarget", async () => {
    const executed: string[] = [];
    const registry = new SessionRuntimeRegistry({
      generation: GENERATION,
      createControllerToken: vi
        .fn()
        .mockReturnValueOnce("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .mockReturnValueOnce("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      semanticMutations: {
        resolveSession: (workspaceName) => `${workspaceName}-session`,
        execute: (operationId, intent) => {
          if (intent.verb !== "workspace.pane.send") throw new Error("unexpected intent");
          executed.push(operationId);
          return sendResult(operationId, intent);
        },
        publishReceipt: (receipt) => ({ type: "interaction.receipt", sequence: 1, ...receipt }),
      },
    });
    const binder = new SessionRuntimeTransportBinder(registry);
    const interactive = binder.bind({
      transport: "terminal-attachment",
      transportLeaseId: "00000000-0000-4000-8000-000000000001",
      session: "alpha-session",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
    });
    const passive = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000002",
      session: "alpha-session",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.tests"],
      interactive: false,
    });
    const source = interactive.executionHandleForSource("pane.editor");
    const first = registry.submitAuthenticatedIntent(source, OP_A, sendIntent());
    const queued = registry.submitAuthenticatedIntent(source, OP_B, sendIntent());
    await vi.waitFor(() => expect(executed).toEqual([OP_A]));

    await interactive.close();
    expect(registry.activeControllerLeaseCount()).toBe(1);
    const sessionHandle = binder.resolveExecutionHandle("alpha-session", "web:document-a");
    expect(sessionHandle).toBeTruthy();
    expect(() => registry.assertExecutionHandle(sessionHandle!)).not.toThrow();
    expect(
      binder.resolveExecutionHandle("alpha-session", "web:document-a", "pane.editor"),
    ).toBeUndefined();
    expect(
      binder.resolveExecutionHandle("alpha-session", "web:document-a", "pane.tests"),
    ).toBeUndefined();
    expect(passive.toJSON()).toMatchObject({ interactive: false, clientId: "web:document-a" });
    expect(() => passive.assertController()).toThrow("Passive transport has no input authority");
    expect(() => registry.assertExecutionHandle(source)).toThrowError(
      expect.objectContaining({ code: "invalid-source-pane-binding" }),
    );

    registry.observeTmuxInteraction({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.tests",
      operationKind: "workspace.pane.send",
    });
    await first;
    await expect(queued).rejects.toMatchObject({ outcome: "rejected" });
    expect(executed).toEqual([OP_A]);

    const replacement = binder.bind({
      transport: "terminal-attachment",
      transportLeaseId: "00000000-0000-4000-8000-000000000003",
      session: "alpha-session",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.editor"],
      interactive: true,
    });
    replacement.assertController("pane.editor");
    expect(registry.activeControllerLeaseCount()).toBe(1);
    await replacement.close();
    expect(registry.activeControllerLeaseCount()).toBe(1);
    await passive.close();
    expect(registry.activeControllerLeaseCount()).toBe(0);
    await registry.dispose();
  });

  it("never grants a controller principal to a passive-only host", async () => {
    const registry = new SessionRuntimeRegistry({
      generation: GENERATION,
      createControllerToken: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    const binder = new SessionRuntimeTransportBinder(registry);
    const passive = binder.bind({
      transport: "pane-stream",
      transportLeaseId: "00000000-0000-4000-8000-000000000002",
      session: "alpha",
      hostClientId: "web:passive-only",
      allowedSourcePaneIds: ["pane.tests"],
      interactive: false,
    });
    expect(binder.resolveExecutionHandle("alpha", "web:passive-only")).toBeUndefined();
    expect(registry.activeControllerLeaseCount()).toBe(0);
    await passive.close();
    await registry.dispose();
  });

  it("rejects queued source work when that pane grant closes but a sibling remains interactive", async () => {
    const executed: string[] = [];
    const registry = new SessionRuntimeRegistry({
      generation: GENERATION,
      createControllerToken: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      semanticMutations: {
        resolveSession: (workspaceName) => `${workspaceName}-session`,
        execute: (operationId, intent) => {
          if (intent.verb !== "workspace.pane.send") throw new Error("unexpected intent");
          executed.push(operationId);
          return sendResult(operationId, intent);
        },
        publishReceipt: (receipt) => ({ type: "interaction.receipt", sequence: 1, ...receipt }),
      },
    });
    const binder = new SessionRuntimeTransportBinder(registry);
    const paneA = binder.bind({
      transport: "terminal-attachment",
      transportLeaseId: "00000000-0000-4000-8000-000000000001",
      session: "alpha-session",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.a"],
      interactive: true,
    });
    const paneB = binder.bind({
      transport: "terminal-attachment",
      transportLeaseId: "00000000-0000-4000-8000-000000000002",
      session: "alpha-session",
      hostClientId: "web:document-a",
      allowedSourcePaneIds: ["pane.b"],
      interactive: true,
    });
    const sourceA = paneA.executionHandleForSource("pane.a");
    const sourceB = paneB.executionHandleForSource("pane.b");
    const first = registry.submitAuthenticatedIntent(sourceA, OP_A, sendIntent());
    const staleA = registry.submitAuthenticatedIntent(sourceA, OP_B, sendIntent());
    await vi.waitFor(() => expect(executed).toEqual([OP_A]));

    await paneA.close();
    expect(registry.activeControllerLeaseCount()).toBe(1);
    expect(() => registry.assertExecutionHandle(sourceA, "pane.a")).toThrowError(
      expect.objectContaining({ code: "invalid-source-pane-binding" }),
    );
    paneB.assertController("pane.b");

    registry.observeTmuxInteraction({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.tests",
      operationKind: "workspace.pane.send",
    });
    await first;
    await expect(staleA).rejects.toMatchObject({ outcome: "rejected" });
    expect(executed).toEqual([OP_A]);

    const currentB = registry.submitAuthenticatedIntent(sourceB, OP_C, sendIntent());
    await vi.waitFor(() => expect(executed).toEqual([OP_A, OP_C]));
    registry.observeTmuxInteraction({
      operationId: OP_C,
      workspaceName: "alpha",
      semanticPaneId: "pane.tests",
      operationKind: "workspace.pane.send",
    });
    await currentB;
    await paneB.close();
    await registry.dispose();
  });
});
