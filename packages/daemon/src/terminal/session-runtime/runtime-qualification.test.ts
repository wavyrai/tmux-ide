import { describe, expect, it, vi } from "vitest";
import type {
  TerminalDeliveryAck,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import { ControlModeOwnershipRegistry } from "../mirror/control-mode-ownership.ts";
import { ScriptedChannelDriver } from "../mirror/__tests__/scripted-channel.ts";
import { SessionRuntimeRegistry } from "./registry.ts";
import { createSessionRuntimeObservability } from "./runtime-observability.ts";
import { RuntimeTraceCorrelator } from "./runtime-trace-correlator.ts";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OFFER = {
  protocolVersions: [1],
  encodings: ["semantic-v1"],
  richPlacements: false,
} as const;

function rig(
  generation = GENERATION,
  options: {
    readonly observability?: ReturnType<typeof createSessionRuntimeObservability> | null;
    readonly createTraceCorrelator?: () => RuntimeTraceCorrelator;
  } = {},
) {
  const drivers: ScriptedChannelDriver[] = [];
  const observability =
    options.observability === undefined
      ? createSessionRuntimeObservability()
      : options.observability;
  let sequence = 0;
  const receipts: Array<{
    operationId: string;
    phase: string;
    sourceSemanticPaneId: string | null;
  }> = [];
  const registry = new SessionRuntimeRegistry({
    generation,
    mirror: {
      createIo: (_session, handlers) => {
        const driver = new ScriptedChannelDriver(handlers);
        drivers.push(driver);
        return driver.channel;
      },
      generatePaneId: () => "pane.generated",
      controlModeOwnershipRegistry: new ControlModeOwnershipRegistry(),
    },
    createControllerToken: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ...(observability ? { observability } : {}),
    ...(options.createTraceCorrelator
      ? { createTraceCorrelator: options.createTraceCorrelator }
      : {}),
    semanticMutations: {
      resolveSession: () => "zz-sim",
      execute: (operationId, intent) => {
        const base = {
          operationId,
          daemonInstanceId: generation,
          workspaceName: intent.workspaceName,
          outcome: "applied" as const,
        };
        if (intent.verb === "workspace.pane.send")
          return {
            ...base,
            verb: intent.verb,
            sourceSemanticPaneId: intent.sourceSemanticPaneId ?? null,
            semanticPaneId: intent.semanticPaneId,
            origin: intent.origin,
            characterCount: intent.text.length,
            byteCount: new TextEncoder().encode(intent.text).byteLength,
            submitted: intent.submit,
          };
        if (intent.verb === "workspace.pane.resize")
          return {
            ...base,
            verb: intent.verb,
            semanticPaneId: intent.semanticPaneId,
            axis: intent.axis,
            cells: intent.cells,
          };
        throw new Error(`unexpected qualification intent ${intent.verb}`);
      },
      publishReceipt: (receipt) => {
        receipts.push(receipt);
        return { type: "interaction.receipt", sequence: ++sequence, ...receipt };
      },
    },
  });
  return { registry, drivers, receipts };
}

function ack(envelope: TerminalDeliveryEnvelope): TerminalDeliveryAck {
  return {
    type: "terminal.delivery.ack",
    workspaceName: envelope.workspaceName,
    semanticPaneId: envelope.semanticPaneId,
    generation: envelope.generation,
    incarnation: envelope.incarnation,
    deliveryNonce: envelope.deliveryNonce,
    transactionId: envelope.transactionId,
    canonicalRevision: envelope.canonicalRevision,
    canonicalStateHash: envelope.canonicalStateHash,
    representationHash: envelope.representationHash,
  };
}

function latest(messages: TerminalDeliveryServerMessage[]): TerminalDeliveryEnvelope {
  return messages.findLast(
    (message) => message.type === "terminal.delivery",
  ) as TerminalDeliveryEnvelope;
}

describe("real SessionRuntime qualification", () => {
  it.each([2, 4, 8])("keeps one control and converges %i clients under flood", async (count) => {
    const { registry, drivers } = rig();
    const clients = Array.from({ length: count }, (_, index) =>
      registry.connect("zz-sim", index === 0 ? "opentui" : "web", `client:${index}`),
    );
    const sinks = clients.map(() => [] as TerminalDeliveryServerMessage[]);
    const openings = clients.map((client, index) =>
      client.openTerminalDelivery(`delivery:${index}`, "pane.alpha", OFFER, (message) =>
        sinks[index]!.push(message),
      ),
    );
    await waitForDriver(drivers);
    await drivers[0]!.settleUntil(
      () => sinks.every((sink) => sink.some((message) => message.type === "terminal.delivery")),
      "initial delivery",
    );
    const connections = await Promise.all(openings);
    connections.forEach((connection, index) => connection.ack(ack(latest(sinks[index]!))));
    for (let index = 0; index < 500; index += 1)
      drivers[0]!.output("%1", index % 2 ? "x\\010" : "y\\010");
    drivers[0]!.output("%1", "\\033[?1049hALT\\033[?1049lFINAL");
    await drivers[0]!.settleUntil(
      () => registry.qualificationSnapshot().sessions[0]?.delivery.inFlight === count,
      "flood convergence",
    );
    const envelopes = sinks.map(latest);
    expect(
      new Set(
        envelopes.map(
          (item) => `${item.incarnation}:${item.canonicalRevision}:${item.canonicalStateHash}`,
        ),
      ).size,
    ).toBe(1);
    connections.forEach((connection, index) => connection.ack(ack(envelopes[index]!)));
    const evidence = registry.qualificationSnapshot();
    expect(evidence.controlChannels).toBe(1);
    expect(evidence.sessions[0]?.delivery).toMatchObject({ clients: count, inFlight: 0 });
    expect(evidence.sessions[0]?.delivery.maxQueueDepth).toBeLessThanOrEqual(2);
    expect(evidence.sessions[0]?.delivery.rawJournalBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(evidence.sessions[0]?.delivery.representationCacheBytes).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
    const canonical = evidence.sessions[0]?.convergence.panes[0];
    expect(canonical).toBeDefined();
    expect(
      evidence.sessions[0]?.convergence.clients.every(
        (client) =>
          client.baselineRevision === canonical?.revision &&
          client.baselineHash === canonical.stateHash &&
          client.inFlightRevision === null &&
          client.queueDepth === 0,
      ),
    ).toBe(true);
    const idle = evidence.sessions[0]?.replicas["pane.alpha"]?.stats;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.qualificationSnapshot().sessions[0]?.replicas["pane.alpha"]?.stats).toEqual(
      idle,
    );
    await Promise.all(connections.map((connection) => connection.close()));
    await Promise.all(clients.map((client) => client.close()));
    await registry.dispose();
  });

  it("correlates real parse, reduce and transport boundaries on one daemon clock", async () => {
    const { registry, drivers } = rig();
    const client = registry.connect("zz-sim", "opentui", "client:trace");
    const messages: TerminalDeliveryServerMessage[] = [];
    const opening = client.openTerminalDelivery("delivery:trace", "pane.alpha", OFFER, (message) =>
      messages.push(message),
    );
    await waitForDriver(drivers);
    await drivers[0]!.settleUntil(
      () => messages.some((message) => message.type === "terminal.delivery"),
      "trace seed",
    );
    const connection = await opening;
    const seed = latest(messages);
    connection.ack(ack(seed));
    const traceId = "00000000-0000-4000-8000-000000000099";
    const lease = client.acquireController();
    const commandsBeforeInvalid = drivers[0]!.channel.written.length;
    expect(() =>
      client.sendInput(lease, "pane.alpha", "text", "must-not-send", "not-a-uuid"),
    ).toThrow();
    expect(drivers[0]!.channel.written).toHaveLength(commandsBeforeInvalid);
    client.sendInput(lease, "pane.alpha", "text", "printf TRACE", traceId);
    // This is deliberately a controlled next-output probe, not general
    // causality: unrelated external output arriving first consumes it.
    drivers[0]!.output("%1", "TRACE");
    await drivers[0]!.settleUntil(
      () => latest(messages).canonicalRevision > seed.canonicalRevision,
      "traced delivery",
    );
    const envelope = latest(messages);
    expect(envelope.performanceTraceId).toBe(traceId);
    const spans = registry
      .qualificationSnapshot()
      .observability.spans.filter(({ traceId }) => traceId === envelope.performanceTraceId);
    expect(spans.map(({ stage }) => stage)).toEqual(["tmux", "parse", "reduce", "transport"]);
    expect(new Set(spans.map(({ processId }) => processId)).size).toBe(1);
    expect(new Set(spans.map(({ clockId }) => clockId)).size).toBe(1);
    expect(spans.every(({ clockKind }) => clockKind === "performance-now")).toBe(true);
    expect(spans.every(({ authority }) => authority?.generation === GENERATION)).toBe(true);
    expect(spans[0]!.authority?.incarnation).toBeNull();
    expect(
      spans.slice(1).every(({ authority }) => authority?.incarnation === envelope.incarnation),
    ).toBe(true);
    for (let index = 1; index < spans.length; index += 1)
      expect(spans[index - 1]!.endedAtMicros).toBeLessThanOrEqual(spans[index]!.startedAtMicros);
    connection.ack(ack(envelope));
    drivers[0]!.output("%1", "INTENDED-LATER");
    await drivers[0]!.settleUntil(
      () => latest(messages).canonicalRevision > envelope.canonicalRevision,
      "post-probe output",
    );
    expect(latest(messages).performanceTraceId).toBeUndefined();
    await connection.close();
    await client.close();
    await registry.dispose();
  });

  it("keeps correlation dormant without probes and propagates explicit probes when observability is disabled", async () => {
    const createTraceCorrelator = vi.fn((scheduler) => new RuntimeTraceCorrelator(scheduler));
    const { registry, drivers } = rig(GENERATION, {
      observability: null,
      createTraceCorrelator,
    });
    const client = registry.connect("zz-sim", "opentui", "client:disabled-trace");
    const messages: TerminalDeliveryServerMessage[] = [];
    const opening = client.openTerminalDelivery(
      "delivery:disabled-trace",
      "pane.alpha",
      OFFER,
      (message) => messages.push(message),
    );
    await waitForDriver(drivers);
    await drivers[0]!.settleUntil(
      () => messages.some((message) => message.type === "terminal.delivery"),
      "disabled trace replica",
    );
    const connection = await opening;
    connection.ack(ack(latest(messages)));
    drivers[0]!.output("%1", "EXTERNAL");
    await drivers[0]!.settleUntil(
      () =>
        (registry.qualificationSnapshot().sessions[0]?.replicas["pane.alpha"]?.revision ?? 0) > 0,
      "disabled trace output",
    );
    expect(createTraceCorrelator).not.toHaveBeenCalled();
    expect(registry.qualificationSnapshot().observability).toEqual({ spans: [], droppedSpans: 0 });
    connection.ack(ack(latest(messages)));
    const traceId = "00000000-0000-4000-8000-000000000098";
    const lease = client.acquireController();
    const priorRevision = latest(messages).canonicalRevision;
    client.sendInput(lease, "pane.alpha", "text", "trace", traceId);
    drivers[0]!.output("%1", "TRACE");
    await drivers[0]!.settleUntil(
      () => latest(messages).canonicalRevision > priorRevision,
      "explicit trace with disabled observability",
    );
    expect(latest(messages).performanceTraceId).toBe(traceId);
    expect(createTraceCorrelator).toHaveBeenCalledOnce();
    expect(registry.qualificationSnapshot().observability).toEqual({ spans: [], droppedSpans: 0 });
    await connection.close();
    await client.close();
    await registry.dispose();
  });

  it("keeps authenticated source and terminal mutation outcomes exact", async () => {
    const { registry, drivers, receipts } = rig();
    const client = registry.connect("zz-sim", "command-center", "client:sdk");
    const opening = client.subscribe("pane.alpha", () => undefined);
    await waitForDriver(drivers);
    await drivers[0]!.settleUntil(
      () => registry.qualificationSnapshot().sessions[0]?.replicas["pane.alpha"]?.revision !== null,
      "replica seed",
    );
    const subscription = await opening;
    const lease = client.acquireController();
    const handle = registry.bindExecutionSource(
      registry.createExecutionHandle(client, lease, ["pane.alpha"]),
      "pane.alpha",
    );
    const operationId = "00000000-0000-4000-8000-000000000001";
    const send = registry.submitAuthenticatedIntent(handle, operationId, {
      verb: "workspace.pane.send",
      workspaceName: "workspace",
      semanticPaneId: "pane.alpha",
      text: "hello",
      submit: true,
      origin: "gui",
    });
    await Promise.resolve();
    registry.observeTmuxInteraction({
      operationId,
      workspaceName: "workspace",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await send;
    await client.submitIntent(lease, "00000000-0000-4000-8000-000000000002", {
      verb: "workspace.pane.resize",
      workspaceName: "workspace",
      semanticPaneId: "pane.alpha",
      axis: "cols",
      cells: 90,
    });
    expect(receipts.map((receipt) => receipt.phase)).toEqual([
      "accepted",
      "observed",
      "accepted",
      "observed",
    ]);
    expect(receipts[1]?.sourceSemanticPaneId).toBe("pane.alpha");
    expect(registry.qualificationSnapshot().mutations).toMatchObject({
      accepted: 2,
      observed: 2,
      rejected: 0,
      timedOut: 0,
      pendingObservations: 0,
    });
    await subscription.close();
    await client.close();
    await registry.dispose();
  });

  it("isolates hidden and slow delivery, then reseeds a NACKed healthy client", async () => {
    const { registry, drivers } = rig();
    const fast = registry.connect("zz-sim", "web", "client:fast");
    const hidden = registry.connect("zz-sim", "web", "client:hidden");
    const slow = registry.connect("zz-sim", "web", "client:slow");
    const fastSink: TerminalDeliveryServerMessage[] = [];
    const hiddenSink: TerminalDeliveryServerMessage[] = [];
    const slowSink: TerminalDeliveryServerMessage[] = [];
    let releaseSlow!: () => void;
    let held: Promise<void> | null = null;
    const openings = [
      fast.openTerminalDelivery("delivery:fast", "pane.alpha", OFFER, (message) =>
        fastSink.push(message),
      ),
      hidden.openTerminalDelivery("delivery:hidden", "pane.alpha", OFFER, (message) =>
        hiddenSink.push(message),
      ),
      slow.openTerminalDelivery("delivery:slow", "pane.alpha", OFFER, (message) => {
        slowSink.push(message);
        return held;
      }),
    ] as const;
    await waitForDriver(drivers);
    await drivers[0]!.settleUntil(
      () => fastSink.length > 0 && hiddenSink.length > 0 && slowSink.length > 0,
      "fault clients seed",
    );
    const [fastConnection, hiddenConnection, slowConnection] = await Promise.all(openings);
    fastConnection.ack(ack(latest(fastSink)));
    hiddenConnection.ack(ack(latest(hiddenSink)));
    slowConnection.ack(ack(latest(slowSink)));
    hiddenConnection.setVisibility("hidden");
    held = new Promise<void>((resolve) => (releaseSlow = resolve));
    drivers[0]!.output("%1", "changed");
    await drivers[0]!.settleUntil(() => latest(fastSink).canonicalRevision > 0, "healthy patch");
    const dropped = latest(fastSink);
    fastConnection.nack({
      type: "terminal.delivery.nack",
      workspaceName: dropped.workspaceName,
      semanticPaneId: dropped.semanticPaneId,
      generation: dropped.generation,
      incarnation: dropped.incarnation,
      deliveryNonce: dropped.deliveryNonce,
      transactionId: dropped.transactionId,
      reason: "hash-mismatch",
      appliedRevision: dropped.baseRevision ?? 0,
    });
    await drivers[0]!.settleUntil(
      () => latest(fastSink).transactionId !== dropped.transactionId,
      "bounded reseed",
    );
    expect(latest(fastSink).frame).toBe("seed");
    fastConnection.ack(ack(latest(fastSink)));
    expect(hiddenSink.filter((message) => message.type === "terminal.delivery")).toHaveLength(1);
    expect(registry.qualificationSnapshot().sessions[0]?.delivery).toMatchObject({
      inFlight: 1,
      nacks: 1,
    });
    expect(
      registry.qualificationSnapshot().sessions[0]?.delivery.maxQueueDepth,
    ).toBeLessThanOrEqual(2);
    releaseSlow();
    await drivers[0]!.settleUntil(
      () => latest(slowSink).canonicalRevision === dropped.canonicalRevision,
      "slow latest pointer",
    );
    slowConnection.ack(ack(latest(slowSink)));
    hiddenConnection.setVisibility("visible");
    await drivers[0]!.settleUntil(
      () => latest(hiddenSink).canonicalRevision === dropped.canonicalRevision,
      "hidden resume",
    );
    hiddenConnection.ack(ack(latest(hiddenSink)));
    const evidence = registry.qualificationSnapshot().sessions[0]!;
    const canonical = evidence.convergence.panes[0]!;
    expect(
      evidence.convergence.clients.every(
        (client) =>
          client.baselineRevision === canonical.revision &&
          client.baselineHash === canonical.stateHash &&
          client.inFlightRevision === null &&
          client.queueDepth === 0,
      ),
    ).toBe(true);
    expect(evidence.delivery).toMatchObject({ inFlight: 0, queueDepth: 0 });
    await Promise.all([fastConnection.close(), hiddenConnection.close(), slowConnection.close()]);
    await Promise.all([fast.close(), hidden.close(), slow.close()]);
    await registry.dispose();
  });

  it("preserves raw text then named-key ordering on the single control lane", async () => {
    const { registry, drivers } = rig();
    const client = registry.connect("zz-sim", "opentui", "client:input");
    const opening = client.subscribe("pane.alpha", () => undefined);
    await waitForDriver(drivers);
    await drivers[0]!.settleUntil(
      () => registry.activeControlChannelCount() === 1,
      "input control",
    );
    const subscription = await opening;
    const lease = client.acquireController();
    client.sendInput(lease, "pane.alpha", "text", "paste界");
    client.sendInput(lease, "pane.alpha", "key", "Enter");
    await drivers[0]!.settleUntil(
      () =>
        drivers[0]!.channel.written.filter((command) => command.startsWith("send-keys")).length >=
        2,
      "ordered input commands",
    );
    const commands = drivers[0]!.channel.written.filter((command) =>
      command.startsWith("send-keys"),
    );
    expect(commands[0]).toContain("-H");
    expect(commands[1]).toContain("Enter");
    expect(registry.qualificationSnapshot().controlChannels).toBe(1);
    await subscription.close();
    await client.close();
    await registry.dispose();
  });

  it("recovers a control exit inside one daemon generation", async () => {
    const first = rig();
    const client = first.registry.connect("zz-sim", "web", "client:first");
    const opening = client.subscribe("pane.alpha", () => undefined);
    await waitForDriver(first.drivers);
    await first.drivers[0]!.settleUntil(
      () => first.registry.activeControlChannelCount() === 1,
      "first control",
    );
    await opening;
    const lease = client.acquireController();
    first.drivers[0]!.exit();
    await first.drivers[0]!.settleUntil(
      () => first.registry.activeControlChannelCount() === 0,
      "control exit",
    );
    const replacement = first.registry.connect("zz-sim", "web", "client:replacement");
    const replacementOpening = replacement.subscribe("pane.alpha", () => undefined);
    await waitForDriver(first.drivers, 2);
    await first.drivers[1]!.settleUntil(
      () => first.registry.activeControlChannelCount() === 1,
      "replacement control",
    );
    await replacementOpening;
    await expect(
      replacement.submitIntent(lease, "00000000-0000-4000-8000-000000000003", {
        verb: "workspace.pane.resize",
        workspaceName: "workspace",
        semanticPaneId: "pane.alpha",
        axis: "cols",
        cells: 91,
      }),
    ).rejects.toThrow();
    await first.registry.dispose();
  });

  it("retires generation A authority before generation B starts", async () => {
    const first = rig(GENERATION);
    const owner = first.registry.connect("zz-sim", "web", "client:generation-a");
    const opening = owner.subscribe("pane.alpha", () => undefined);
    await waitForDriver(first.drivers);
    await first.drivers[0]!.settleUntil(
      () => first.registry.activeControlChannelCount() === 1,
      "generation A control",
    );
    await opening;
    const lease = owner.acquireController();
    const handle = first.registry.createExecutionHandle(owner, lease, ["pane.alpha"]);
    await first.registry.dispose();

    const second = rig("22222222-2222-4222-8222-222222222222");
    const next = second.registry.connect("zz-sim", "web", "client:generation-b");
    const nextOpening = next.subscribe("pane.alpha", () => undefined);
    await waitForDriver(second.drivers);
    await second.drivers[0]!.settleUntil(
      () => second.registry.activeControlChannelCount() === 1,
      "generation B control",
    );
    await nextOpening;
    expect(next.generation).toBe("22222222-2222-4222-8222-222222222222");
    await expect(
      first.registry.submitAuthenticatedIntent(handle, "00000000-0000-4000-8000-000000000004", {
        verb: "workspace.pane.resize",
        workspaceName: "workspace",
        semanticPaneId: "pane.alpha",
        axis: "cols",
        cells: 92,
      }),
    ).rejects.toThrow("stale");
    await expect(
      next.submitIntent(lease, "00000000-0000-4000-8000-000000000005", {
        verb: "workspace.pane.resize",
        workspaceName: "workspace",
        semanticPaneId: "pane.alpha",
        axis: "cols",
        cells: 92,
      }),
    ).rejects.toThrow();
    await second.registry.dispose();
  });
});

async function waitForDriver(drivers: ScriptedChannelDriver[], count = 1): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    await Promise.resolve();
    if (drivers.length >= count) return;
  }
  throw new Error(`Expected ${count} scripted channel driver(s)`);
}
