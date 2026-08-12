import type {
  TerminalDeliveryAck,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import { setTimeout as delay } from "node:timers/promises";

import { ControlModeOwnershipRegistry } from "../packages/daemon/src/terminal/mirror/control-mode-ownership.ts";
import { ScriptedChannelDriver } from "../packages/daemon/src/terminal/mirror/__tests__/scripted-channel.ts";
import { SessionRuntimeRegistry } from "../packages/daemon/src/terminal/session-runtime/registry.ts";

const generation = "77777777-7777-4777-8777-777777777777";
const clientCount = Number(process.env.TMUX_IDE_REFERENCE_MEMORY_CLIENTS ?? 8);
const warmupCycles = Number(process.env.TMUX_IDE_REFERENCE_MEMORY_WARMUP ?? 48);
const sampleCycles = Number(process.env.TMUX_IDE_REFERENCE_MEMORY_SAMPLES ?? 24);
const writesPerCycle = Number(process.env.TMUX_IDE_REFERENCE_MEMORY_WRITES ?? 4);

if (!globalThis.gc) throw new Error("Reference memory qualification requires --expose-gc");
for (const [name, value] of Object.entries({
  clientCount,
  warmupCycles,
  sampleCycles,
  writesPerCycle,
})) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`);
}

const drivers: ScriptedChannelDriver[] = [];
const registry = new SessionRuntimeRegistry({
  generation,
  mirror: {
    createIo: (_session, handlers) => {
      const driver = new ScriptedChannelDriver(handlers, { maxTurns: 500 });
      drivers.push(driver);
      return driver.channel;
    },
    generatePaneId: () => "pane.reference",
    controlModeOwnershipRegistry: new ControlModeOwnershipRegistry(),
  },
  createControllerToken: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
});

const clients = Array.from({ length: clientCount }, (_, index) =>
  registry.connect("reference-memory", "opentui", `reference:${index}`),
);
const sinks = clients.map(() => [] as TerminalDeliveryServerMessage[]);
const openings = clients.map((client, index) =>
  client.openTerminalDelivery(
    `delivery:${index}`,
    "pane.alpha",
    { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
    (message) => sinks[index]!.push(message),
  ),
);
await waitForDriver();
await drivers[0]!.settleUntil(
  () => sinks.every((sink) => latest(sink) !== null),
  "reference memory seed",
);
const connections = await Promise.all(openings);
connections.forEach((connection, index) => connection.ack(ack(latestRequired(sinks[index]!))));

const samples: Array<{
  ordinal: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  queueDepth: number;
  representationCacheBytes: number;
  rawJournalBytes: number;
}> = [];

try {
  for (let cycle = 0; cycle < warmupCycles + sampleCycles; cycle += 1) {
    const priorRevision = latestRequired(sinks[0]!).canonicalRevision;
    const cell = cycle % 2 === 0 ? "x" : "y";
    const screen = `\\033[H${Array.from({ length: 50 }, () => `${cell.repeat(100)}\\015\\012`).join(
      "",
    )}`;
    for (let write = 0; write < writesPerCycle; write += 1) {
      // A changing line exercises the real parser, canonical replica, patch,
      // representation cache, and all eight delivery lanes without retaining
      // unbounded terminal history.
      drivers[0]!.output("%1", screen);
    }
    await delay(20);
    await drivers[0]!.settleUntil(
      () => latestRequired(sinks[0]!).canonicalRevision > priorRevision,
      `reference memory cycle ${cycle}`,
    );
    const revision = latestRequired(sinks[0]!).canonicalRevision;
    await drivers[0]!.settleUntil(
      () =>
        sinks.every((sink) => latestRequired(sink).canonicalRevision === revision) &&
        registry.qualificationSnapshot().sessions[0]?.delivery.inFlight === clientCount,
      `reference memory fanout ${cycle}`,
    );
    connections.forEach((connection, index) => connection.ack(ack(latestRequired(sinks[index]!))));
    await drivers[0]!.settleUntil(
      () => registry.qualificationSnapshot().sessions[0]?.delivery.inFlight === 0,
      `reference memory ack ${cycle}`,
    );
    if (cycle < warmupCycles) continue;
    globalThis.gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.gc();
    const memory = process.memoryUsage();
    const delivery = registry.qualificationSnapshot().sessions[0]!.delivery;
    samples.push({
      ordinal: samples.length,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      queueDepth: delivery.queueDepth,
      representationCacheBytes: delivery.representationCacheBytes,
      rawJournalBytes: delivery.rawJournalBytes,
    });
  }
} finally {
  await Promise.all(connections.map((connection) => connection.close()));
  await Promise.all(clients.map((client) => client.close()));
  await registry.dispose();
}

process.stdout.write(
  `${JSON.stringify({
    version: 1,
    runtime: "canonical-session-runtime",
    explicitGc: true,
    clientCount,
    warmupCycles,
    sampleCycles,
    writesPerCycle,
    samples,
  })}\n`,
);

function latest(messages: TerminalDeliveryServerMessage[]): TerminalDeliveryEnvelope | null {
  return (
    (messages.findLast((message) => message.type === "terminal.delivery") as
      | TerminalDeliveryEnvelope
      | undefined) ?? null
  );
}

function latestRequired(messages: TerminalDeliveryServerMessage[]): TerminalDeliveryEnvelope {
  const envelope = latest(messages);
  if (!envelope) throw new Error("Expected a terminal delivery envelope");
  return envelope;
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

async function waitForDriver(): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    await Promise.resolve();
    if (drivers.length > 0) return;
  }
  throw new Error("Expected one scripted control channel");
}
