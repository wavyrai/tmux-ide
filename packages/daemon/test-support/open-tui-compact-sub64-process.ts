import { spawnSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  encodeCompactSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
  type TerminalReplicaState,
} from "@tmux-ide/core";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalDeliveryAck,
  TerminalDeliveryEnvelope,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import { connectOpenTuiWorkspaceRuntimePort } from "../src/tui/mirror/open-tui-workspace-runtime-port.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const workspaceName = "workspace.alpha";
const semanticPaneId = "pane.a";
const incarnation = `${generation}:1`;
const workloadMode = process.argv[2] === "workload";

function compactSeed(
  snapshot: TerminalReplicaSnapshot,
  suffix: string,
  targetIncarnation = incarnation,
  revision = 0,
) {
  const bytes = encodeCompactSemanticTerminalUpdate({ frame: "seed", revision, snapshot });
  const transactionId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const envelope: TerminalDeliveryEnvelope = {
    type: "terminal.delivery",
    workspaceName,
    semanticPaneId,
    generation,
    incarnation: targetIncarnation,
    deliveryNonce: nonce,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-compact-v1",
    frame: "seed",
    baseRevision: null,
    canonicalRevision: revision,
    canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1_024))),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: true,
  };
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes), bytes };
}

function compactDeliveryFromBytes(options: {
  bytes: Uint8Array;
  canonicalStateHash: string;
  targetIncarnation: string;
  baseRevision: number | null;
  revision: number;
  suffix: string;
}) {
  const transactionId = `00000000-0000-4000-8000-${options.suffix.padStart(12, "0")}`;
  const envelope: TerminalDeliveryEnvelope = {
    type: "terminal.delivery",
    workspaceName,
    semanticPaneId,
    generation,
    incarnation: options.targetIncarnation,
    deliveryNonce: nonce,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-compact-v1",
    frame: options.baseRevision === null ? "seed" : "patch",
    baseRevision: options.baseRevision,
    canonicalRevision: options.revision,
    canonicalStateHash: options.canonicalStateHash,
    representationHash: hashTerminalDeliveryRepresentation(options.bytes),
    representationBytes: options.bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(options.bytes.byteLength / (256 * 1_024))),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: true,
  };
  return {
    bytes: options.bytes,
    envelope,
    chunks: splitTerminalDeliveryChunks(transactionId, options.bytes),
  };
}

function compactHistoryPatch(
  baseline: TerminalReplicaSnapshot,
  append: readonly TerminalReplicaSnapshot["history"][number][],
  targetIncarnation: string,
  baseRevision: number,
  revision: number,
  suffix = "310",
) {
  const patch = Object.freeze({
    dimensions: Object.freeze({ cols: baseline.cols, rows: baseline.rows }),
    rows: Object.freeze([]),
    historyDelta: Object.freeze({ trim: append.length, append: Object.freeze([...append]) }),
  });
  const nextHistory = Object.freeze([
    ...baseline.history.slice(append.length),
    ...append,
  ]) as TerminalReplicaSnapshot["history"];
  const next = Object.freeze({ ...baseline, history: nextHistory });
  const bytes = encodeCompactSemanticTerminalUpdate({
    frame: "patch",
    baseRevision,
    revision,
    patch,
  });
  const transactionId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const envelope: TerminalDeliveryEnvelope = {
    type: "terminal.delivery",
    workspaceName,
    semanticPaneId,
    generation,
    incarnation: targetIncarnation,
    deliveryNonce: nonce,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-compact-v1",
    frame: "patch",
    baseRevision,
    canonicalRevision: revision,
    canonicalStateHash: hashTerminalReplicaSnapshot(next),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1_024))),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: true,
  };
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes), bytes, next };
}

function retargetCompactHistoryPatch(
  template: Pick<ReturnType<typeof compactHistoryPatch>, "bytes" | "envelope">,
  baseRevision: number,
  revision: number,
  suffix: string,
  canonicalStateHash = template.envelope.canonicalStateHash,
) {
  const source = new TextDecoder().decode(template.bytes);
  const retargeted = source
    .replace(/"b":[0-9]+/u, `"b":${baseRevision}`)
    .replace(/"r":[0-9]+/u, `"r":${revision}`)
    // Vary an otherwise semantic-neutral body byte range per cycle so the
    // endpoint proves row-level authenticated reuse rather than whole-wire
    // memoization.
    .replace(/"p":/u, `"p":${" ".repeat(revision)}`);
  const bytes = new TextEncoder().encode(retargeted);
  const transactionId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const envelope = Object.freeze({
    ...template.envelope,
    transactionId,
    baseRevision,
    canonicalRevision: revision,
    canonicalStateHash,
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1_024))),
  });
  return {
    envelope,
    chunks: splitTerminalDeliveryChunks(transactionId, bytes),
    bytes,
  };
}

function retargetCompactHistoryPatchInPlace(
  template: Pick<ReturnType<typeof retargetCompactHistoryPatch>, "bytes" | "envelope">,
  baseRevision: number,
  revision: number,
  suffix: string,
  canonicalStateHash: string,
) {
  const bytes = template.bytes;
  const baseMarker = new TextEncoder().encode('"b":');
  const revisionMarker = new TextEncoder().encode(',"r":');
  const find = (marker: Uint8Array): number => {
    outer: for (let offset = 0; offset <= bytes.byteLength - marker.byteLength; offset += 1) {
      for (let index = 0; index < marker.byteLength; index += 1)
        if (bytes[offset + index] !== marker[index]) continue outer;
      return offset + marker.byteLength;
    }
    throw new Error("compact workload retarget marker missing");
  };
  const baseOffset = find(baseMarker);
  const revisionOffset = find(revisionMarker);
  const baseText = String(baseRevision);
  const revisionText = String(revision);
  if (baseText.length !== 2 || revisionText.length !== 2)
    throw new Error("compact workload revision width changed");
  bytes[baseOffset] = baseText.charCodeAt(0);
  bytes[baseOffset + 1] = baseText.charCodeAt(1);
  bytes[revisionOffset] = revisionText.charCodeAt(0);
  bytes[revisionOffset + 1] = revisionText.charCodeAt(1);
  const payloadMarker = new TextEncoder().encode('"p":');
  const payloadOffset = find(payloadMarker);
  bytes[payloadOffset] = revision % 2 === 0 ? 0x20 : 0x09;
  const transactionId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const envelope = Object.freeze({
    ...template.envelope,
    transactionId,
    baseRevision,
    canonicalRevision: revision,
    canonicalStateHash,
    representationHash: hashTerminalDeliveryRepresentation(bytes),
  });
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes), bytes };
}

function compactPlacementsPatch(
  baseline: TerminalReplicaSnapshot,
  placements: TerminalReplicaSnapshot["placements"],
  targetIncarnation: string,
  baseRevision: number,
  revision: number,
) {
  const patch = Object.freeze({ rows: Object.freeze([]), placements });
  const next = Object.freeze({ ...baseline, placements });
  const bytes = encodeCompactSemanticTerminalUpdate({
    frame: "patch",
    baseRevision,
    revision,
    patch,
  });
  const transactionId = "00000000-0000-4000-8000-000000000411";
  const envelope: TerminalDeliveryEnvelope = {
    type: "terminal.delivery",
    workspaceName,
    semanticPaneId,
    generation,
    incarnation: targetIncarnation,
    deliveryNonce: nonce,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-compact-v1",
    frame: "patch",
    baseRevision,
    canonicalRevision: revision,
    canonicalStateHash: hashTerminalReplicaSnapshot(next),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1_024))),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: true,
  };
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes) };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error(
        `compact endpoint child timed out ack=${acknowledgements.length} nack=${nacks.length} delivery=${deliveryCount}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function loadWorkloadWire(): Readonly<{
  seedBytes: Uint8Array;
  patchBytes: Uint8Array;
  seedHash: string;
  firstHash: string;
  targetHash: string;
}> {
  const producerFixture = fileURLToPath(
    new URL("./open-tui-compact-workload-producer.ts", import.meta.url),
  );
  const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
  const produced = spawnSync(tsx, [producerFixture], {
    encoding: "utf8",
    maxBuffer: 32 * 1_024 * 1_024,
    timeout: 30_000,
  });
  if (produced.status !== 0) throw new Error(`compact workload producer failed ${produced.stderr}`);
  const wire = JSON.parse(produced.stdout) as {
    readonly seed: string;
    readonly patch: string;
    readonly seedHash: string;
    readonly firstHash: string;
    readonly targetHash: string;
  };
  return Object.freeze({
    seedBytes: Buffer.from(wire.seed, "base64"),
    patchBytes: Buffer.from(wire.patch, "base64"),
    seedHash: wire.seedHash,
    firstHash: wire.firstHash,
    targetHash: wire.targetHash,
  });
}

const negotiation = negotiateTerminalDelivery(
  {
    protocolVersions: [1],
    encodings: ["semantic-compact-v1", "semantic-v1"],
    richPlacements: true,
  },
  generation,
  nonce,
);
if (!negotiation.accepted) throw new Error("compact endpoint negotiation failed");

let streamOptions: Record<string, (...args: never[]) => void> | null = null;
const acknowledgements: TerminalDeliveryAck[] = [];
const nacks: unknown[] = [];
const client = {
  daemonInstanceId: generation,
  requestId: "00000000-0000-4000-8000-000000000010",
  effectiveViewerMode: "interactive",
  authoritySnapshot: null,
  setPresence() {},
  noteActivity() {},
  async requestAuthority() {
    return null;
  },
  async releaseAuthority() {},
  async sendTerminalInput() {
    return "ok" as const;
  },
  sendText() {},
  sendKey() {},
  async fitViewport() {},
  ack(ack: TerminalDeliveryAck) {
    acknowledgements.push(ack);
  },
  nack(nack: unknown) {
    nacks.push(nack);
  },
  setVisibility() {},
  async submitIntent() {
    return null;
  },
  close() {},
  onReceipt() {
    return () => {};
  },
};
const routing = {
  daemonInstanceId: generation,
  workspaceName,
  sessionName: "alpha",
  assertCurrent() {},
  async openPaneStream(_expected: unknown, options: Record<string, unknown>) {
    streamOptions = options as typeof streamOptions;
    const negotiated = options.onNegotiated as (pane: string, value: unknown) => void;
    negotiated(semanticPaneId, { accepted: true, negotiated: negotiation.negotiated });
    (options.onLayout as (layout: unknown) => void)({
      type: "layout",
      semanticWindowId: "window.main",
      windowName: "main",
      currentWindow: true,
      cols: 132,
      rows: 41,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [
        {
          pane: semanticPaneId,
          left: 0,
          top: 1,
          width: 132,
          height: 40,
          active: true,
        },
      ],
    });
    const seed = compactSeed(blankTerminalReplicaSnapshot(132, 41), "10");
    const deliver = options.onTerminalDelivery as (pane: string, message: unknown) => void;
    deliver(semanticPaneId, seed.envelope);
    for (const chunk of seed.chunks) deliver(semanticPaneId, chunk);
    return client;
  },
  async retire() {},
};
const decodeProfiles: Readonly<Record<string, unknown>>[] = [];
const port = await connectOpenTuiWorkspaceRuntimePort({
  inventory: Object.freeze({
    workspaceName,
    workspaceId: "workspace-id",
    sessionId: "alpha",
    daemonGeneration: generation,
    shellGeneration: 1,
    semanticPaneIds: Object.freeze([semanticPaneId]),
  }),
  routing: routing as never,
  onDiagnostic(phase, details) {
    if (phase === "compact-decode") decodeProfiles.push(details);
  },
});
const subscription = await port.subscribeTerminal({ workspaceName, semanticPaneId });
let state: TerminalReplicaState | null = null;
let deliveryCount = 0;
const applyProfiles: unknown[] = [];
subscription.onUpdate((update: CanonicalTerminalReplicaUpdate) => {
  const result = applyTerminalReplicaUpdate(state, update, {
    authenticatedFrameHash: "0000000000000000",
    instrumentation: {
      nowMicros: () => 1,
      onComplete: (profile) => applyProfiles.push(profile),
    },
  });
  if (result.status !== "applied") throw new Error(`compact child reducer ${result.status}`);
  state = result.state;
  deliveryCount += 1;
});

const blank = blankTerminalReplicaSnapshot(132, 41);
let baseline: TerminalReplicaSnapshot | null = Object.freeze({
  ...blank,
  history: Object.freeze(Array.from({ length: 5_000 }, () => blank.grid[0]!)),
});
const baselineIncarnation = `${generation}:2`;
let baselineDelivery: ReturnType<typeof compactSeed> | null = compactSeed(
  baseline,
  "309",
  baselineIncarnation,
  1,
);
const baselineTransaction = baselineDelivery.envelope.transactionId;
const deliver = streamOptions!.onTerminalDelivery as (pane: string, message: unknown) => void;
const deliverChunksAsSocketMessages = async (
  chunks: readonly ReturnType<typeof splitTerminalDeliveryChunks>[number][],
): Promise<void> => {
  for (const chunk of chunks) {
    const consumed = (
      deliver as unknown as (
        pane: string,
        message: unknown,
      ) => void | { readonly consumedOwnedChunk: true }
    )(semanticPaneId, chunk);
    if (consumed?.consumedOwnedChunk === true) {
      const backing = chunk.bytes.buffer as ArrayBuffer & {
        transfer?: (newByteLength?: number) => ArrayBuffer;
      };
      if (typeof backing.transfer === "function") backing.transfer(0);
      else structuredClone(backing, { transfer: [backing] });
    }
    // Each WebSocket message is dispatched as its own task. Keeping that
    // boundary here ensures the child measures the endpoint's per-message
    // assembly/hash work rather than an impossible fixture-created burst.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};
deliver(semanticPaneId, baselineDelivery.envelope);
await deliverChunksAsSocketMessages(baselineDelivery.chunks);
await waitFor(
  () => acknowledgements.some(({ transactionId }) => transactionId === baselineTransaction),
  30_000,
);
baseline = null;
baselineDelivery = null;
await new Promise((resolve) => setTimeout(resolve, 50));

const baselineSnapshot = state?.snapshot;
if (!baselineSnapshot) throw new Error("compact child baseline missing");
let patchDelivery: ReturnType<typeof compactHistoryPatch> | null = compactHistoryPatch(
  baselineSnapshot,
  Object.freeze(Array.from({ length: 2_000 }, () => blank.grid[0]!)),
  baselineIncarnation,
  1,
  2,
);
const patchEnvelope = patchDelivery.envelope;
const patchChunks = patchDelivery.chunks;
if (workloadMode) {
  let wire: ReturnType<typeof loadWorkloadWire> | null = loadWorkloadWire();
  const workloadSeedHash = wire.seedHash;
  const workloadFirstHash = wire.firstHash;
  const workloadTargetHash = wire.targetHash;
  const workloadIncarnation = `${generation}:3`;
  const seedBytes = new TextEncoder().encode(
    new TextDecoder().decode(wire.seedBytes).replace(/"r":3/u, '"r":10'),
  );
  let workloadSeed: ReturnType<typeof compactDeliveryFromBytes> | null = compactDeliveryFromBytes({
    bytes: seedBytes,
    canonicalStateHash: workloadSeedHash,
    targetIncarnation: workloadIncarnation,
    baseRevision: null,
    revision: 10,
    suffix: "500",
  });
  const workloadSeedTransaction = workloadSeed.envelope.transactionId;
  const canonicalTemplate = compactDeliveryFromBytes({
    bytes: wire.patchBytes,
    canonicalStateHash: workloadFirstHash,
    targetIncarnation: workloadIncarnation,
    baseRevision: 3,
    revision: 4,
    suffix: "501",
  });
  const retargetTemplate = retargetCompactHistoryPatch(
    canonicalTemplate,
    10,
    11,
    "502",
    workloadFirstHash,
  );
  wire = null;
  patchDelivery = null;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
  eventLoopDelay.enable();
  let peakRssBytes = 0;
  let peakHeapBytes = 0;
  deliver(semanticPaneId, patchEnvelope);
  await deliverChunksAsSocketMessages(patchChunks);
  await waitFor(
    () =>
      acknowledgements.some(({ transactionId }) => transactionId === patchEnvelope.transactionId),
    5_000,
  );
  deliver(semanticPaneId, workloadSeed.envelope);
  await deliverChunksAsSocketMessages(workloadSeed.chunks);
  await waitFor(
    () => acknowledgements.some(({ transactionId }) => transactionId === workloadSeedTransaction),
    30_000,
  );
  workloadSeed = null;
  let workloadMinBytes = Number.MAX_SAFE_INTEGER;
  let workloadMaxBytes = 0;
  const measuredRssBytes: number[] = [];
  const measuredHeapBytes: number[] = [];
  const measuredHeapTotalBytes: number[] = [];
  const measuredExternalBytes: number[] = [];
  const measuredArrayBufferBytes: number[] = [];
  const postFenceLowWater = async (): Promise<NodeJS.MemoryUsage> => {
    let lowWater: NodeJS.MemoryUsage | null = null;
    for (let sampleOrdinal = 1; sampleOrdinal <= 8; sampleOrdinal += 1) {
      const memory = process.memoryUsage();
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
      peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
      if (
        lowWater === null ||
        memory.heapUsed < lowWater.heapUsed ||
        (memory.heapUsed === lowWater.heapUsed && memory.rss < lowWater.rss)
      )
        lowWater = memory;
      if (sampleOrdinal < 8) await new Promise((resolve) => setTimeout(resolve, 8));
    }
    return lowWater!;
  };
  for (let cycle = 1; cycle <= 24; cycle += 1) {
    let workload: ReturnType<typeof retargetCompactHistoryPatchInPlace> | null =
      retargetCompactHistoryPatchInPlace(
        retargetTemplate,
        cycle + 9,
        cycle + 10,
        String(500 + cycle),
        cycle === 1 ? workloadFirstHash : workloadTargetHash,
      );
    workloadMinBytes = Math.min(workloadMinBytes, workload.envelope.representationBytes);
    workloadMaxBytes = Math.max(workloadMaxBytes, workload.envelope.representationBytes);
    const workloadTransactionId = workload.envelope.transactionId;
    deliver(semanticPaneId, workload.envelope);
    await deliverChunksAsSocketMessages(workload.chunks);
    await waitFor(
      () => acknowledgements.some(({ transactionId }) => transactionId === workloadTransactionId),
      15_000,
    );
    // The producer/socket owns wire buffers in production. Release this
    // fixture's synthetic producer view before sampling the OpenTUI process.
    workload = null;
    const memory = await postFenceLowWater();
    if (cycle > 8) {
      measuredRssBytes.push(memory.rss);
      measuredHeapBytes.push(memory.heapUsed);
      measuredHeapTotalBytes.push(memory.heapTotal);
      measuredExternalBytes.push(memory.external);
      measuredArrayBufferBytes.push(memory.arrayBuffers);
    }
  }
  eventLoopDelay.disable();
  const maxHeartbeatDelayMs = Number(eventLoopDelay.max) / 1_000_000;
  if (nacks.length !== 0) throw new Error("compact workload child received a NACK");
  if (state?.hash !== workloadTargetHash)
    throw new Error("compact workload child canonical hash mismatch");
  await subscription.close();
  await port.close();
  const theilSen = (values: readonly number[]): number => {
    const slopes: number[] = [];
    for (let left = 0; left < values.length; left += 1)
      for (let right = left + 1; right < values.length; right += 1)
        slopes.push((values[right]! - values[left]!) / (right - left));
    slopes.sort((left, right) => left - right);
    return slopes[Math.floor(slopes.length / 2)] ?? 0;
  };
  process.stdout.write(
    `${JSON.stringify({
      workloadMinBytes,
      workloadMaxBytes,
      workloadCycles: 24,
      explicitGcAvailable: typeof globalThis.gc === "function",
      maxHeartbeatDelayMs,
      peakRssBytes,
      peakHeapBytes,
      rssSlopeBytesPerSample: theilSen(measuredRssBytes),
      heapSlopeBytesPerSample: theilSen(measuredHeapBytes),
      rssGrowthBytes: Math.max(0, measuredRssBytes.at(-1)! - measuredRssBytes[0]!),
      heapGrowthBytes: Math.max(0, measuredHeapBytes.at(-1)! - measuredHeapBytes[0]!),
      measuredRssBytes,
      measuredHeapBytes,
      measuredHeapTotalBytes,
      measuredExternalBytes,
      measuredArrayBufferBytes,
      deliveryCount,
      ackCount: acknowledgements.length,
      finalHashExact: state?.hash === workloadTargetHash,
      applyProfiles,
      decodeProfiles,
    })}\n`,
  );
} else {
  const placementText = "p".repeat(250);
  const placements = Object.freeze(
    Array.from({ length: 4_096 }, (_, index) =>
      Object.freeze({
        id: `${index}-${placementText}`,
        kind: "image",
        row: index % 41,
        column: index % 132,
        columns: 1,
        rows: 1,
        contentDigest: `${placementText}-${index}`,
      }),
    ),
  );
  const placementIncarnation = `${generation}:3`;
  const placementSeedSnapshot = Object.freeze({ ...patchDelivery.next, placements });
  const placementSeed = compactSeed(placementSeedSnapshot, "410", placementIncarnation, 3);
  const changedPlacements = Object.freeze(
    placements.map((placement, index) =>
      Object.freeze({ ...placement, contentDigest: `${placementText}-changed-${index}` }),
    ),
  );
  const placementPatch = compactPlacementsPatch(
    placementSeedSnapshot,
    changedPlacements,
    placementIncarnation,
    3,
    4,
  );
  patchDelivery = null;
  await new Promise((resolve) => setTimeout(resolve, 50));

  let heartbeatActive = true;
  let heartbeatAt = performance.now();
  let maxHeartbeatDelayMs = 0;
  let nextResourceSampleAt = heartbeatAt;
  let peakRssBytes = 0;
  let peakHeapBytes = 0;
  const heartbeat = (): void => {
    const now = performance.now();
    maxHeartbeatDelayMs = Math.max(maxHeartbeatDelayMs, now - heartbeatAt);
    heartbeatAt = now;
    if (now >= nextResourceSampleAt) {
      const memory = process.memoryUsage();
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
      peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
      nextResourceSampleAt = now + 16;
    }
    if (heartbeatActive) setImmediate(heartbeat);
  };
  setImmediate(heartbeat);
  deliver(semanticPaneId, patchEnvelope);
  for (const chunk of patchChunks) deliver(semanticPaneId, chunk);
  await waitFor(
    () =>
      acknowledgements.some(({ transactionId }) => transactionId === patchEnvelope.transactionId),
    5_000,
  );
  deliver(semanticPaneId, placementSeed.envelope);
  for (const chunk of placementSeed.chunks) deliver(semanticPaneId, chunk);
  await waitFor(
    () =>
      acknowledgements.some(
        ({ transactionId }) => transactionId === placementSeed.envelope.transactionId,
      ) || nacks.length > 0,
    30_000,
  );
  if (nacks.length > 0) throw new Error(`compact placement seed NACK ${JSON.stringify(nacks)}`);
  deliver(semanticPaneId, placementPatch.envelope);
  for (const chunk of placementPatch.chunks) deliver(semanticPaneId, chunk);
  await waitFor(
    () =>
      acknowledgements.some(
        ({ transactionId }) => transactionId === placementPatch.envelope.transactionId,
      ),
    15_000,
  );
  heartbeatActive = false;
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (nacks.length !== 0) throw new Error("compact child received a NACK");
  if (state?.hash !== placementPatch.envelope.canonicalStateHash)
    throw new Error("compact child canonical hash mismatch");
  await subscription.close();
  await port.close();
  process.stdout.write(
    `${JSON.stringify({
      representationBytes: patchEnvelope.representationBytes,
      placementSeedBytes: placementSeed.envelope.representationBytes,
      placementPatchBytes: placementPatch.envelope.representationBytes,
      maxHeartbeatDelayMs,
      peakRssBytes,
      peakHeapBytes,
      deliveryCount,
      ackCount: acknowledgements.length,
      finalHashExact: state?.hash === placementPatch.envelope.canonicalStateHash,
      applyProfiles,
      decodeProfiles,
    })}\n`,
  );
}
