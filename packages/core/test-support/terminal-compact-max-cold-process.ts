import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  decodeVerifiedCompactSemanticTerminalUpdateCooperatively,
  encodeCompactSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  splitTerminalDeliveryChunks,
  TerminalDeliveryAssembler,
} from "../src/index.ts";

if (process.argv[2] === "decode") {
  const input = readFileSync(0);
  const length = input.readUInt32BE(0);
  const stateHash = input.subarray(4, 20).toString("ascii");
  const representationHash = input.subarray(20, 36).toString("ascii");
  const bytes = new Uint8Array(input.buffer, input.byteOffset + 36, length);
  const transactionId = "00000000-0000-4000-8000-000000000001";
  const chunks = splitTerminalDeliveryChunks(transactionId, bytes);
  const assembler = new TerminalDeliveryAssembler({
    type: "terminal.delivery",
    workspaceName: "cold",
    semanticPaneId: "pane-a",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "00000000-0000-4000-8000-000000000001:0",
    deliveryNonce: "00000000-0000-4000-8000-000000000002",
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-compact-v1",
    frame: "seed",
    baseRevision: null,
    canonicalRevision: 0,
    canonicalStateHash: stateHash,
    representationHash,
    representationBytes: bytes.byteLength,
    chunkCount: chunks.length,
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: true,
  });
  let timerDelayMs = 0;
  let heartbeatActive = true;
  let heartbeatAt = performance.now();
  let sliceCpu = process.cpuUsage();
  let maxSliceMs = 0;
  let maxSliceStage = "start";
  const recordSlice = (stage: string): void => {
    const usage = process.cpuUsage(sliceCpu);
    const elapsed = (usage.user + usage.system) / 1_000;
    if (elapsed > maxSliceMs) {
      maxSliceMs = elapsed;
      maxSliceStage = stage;
    }
  };
  const heartbeat = (): void => {
    const now = performance.now();
    timerDelayMs = Math.max(timerDelayMs, now - heartbeatAt);
    heartbeatAt = now;
    if (heartbeatActive) setImmediate(heartbeat);
  };
  setImmediate(heartbeat);
  for (const chunk of chunks) {
    assembler.write(chunk);
    recordSlice("assembler-chunk");
    await new Promise<void>((resolve) => setImmediate(resolve));
    sliceCpu = process.cpuUsage();
  }
  const assembledBytes = assembler.complete();
  const verified = await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
    assembledBytes,
    null,
    stateHash,
    {
      grantReducerAdoption: true,
      yieldControl: async () => {
        recordSlice(new Error().stack?.split("\n")[2]?.trim() ?? "unknown");
        await new Promise<void>((resolve) => setImmediate(resolve));
        sliceCpu = process.cpuUsage();
      },
    },
  );
  if (verified.payload.frame !== "seed") throw new Error("max compact seed missing");
  const applied = applyTerminalReplicaUpdate(
    null,
    {
      type: "terminal.seed",
      workspaceName: "cold",
      semanticPaneId: "pane-a",
      generation: "00000000-0000-4000-8000-000000000001",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      revision: 0,
      cols: verified.payload.snapshot.cols,
      rows: verified.payload.snapshot.rows,
      stateHash,
      hashAlgorithm: "fnv1a64-v1",
      snapshot: verified.payload.snapshot,
    },
    { authenticatedFrameHash: representationHash },
  );
  if (applied.status !== "applied" || applied.state.snapshot !== verified.canonicalSnapshot)
    throw new Error("max compact seed was not atomically adopted");
  const denseBytes = new TextEncoder().encode(`[${"0,".repeat(7_500_000)}0]`);
  let denseRejected = false;
  try {
    await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
      denseBytes,
      null,
      "0000000000000000",
      {
        yieldControl: async () => {
          recordSlice("dense-json");
          await new Promise<void>((resolve) => setImmediate(resolve));
          sliceCpu = process.cpuUsage();
        },
      },
    );
  } catch {
    denseRejected = true;
  }
  if (!denseRejected) throw new Error("dense malformed compact representation was accepted");
  recordSlice("final-return");
  await new Promise<void>((resolve) => setImmediate(resolve));
  heartbeatActive = false;
  const memory = process.memoryUsage();
  process.stdout.write(
    `${JSON.stringify({
      timerDelayMs,
      maxSliceMs,
      maxSliceStage,
      representationBytes: bytes.byteLength,
      denseRepresentationBytes: denseBytes.byteLength,
      denseRejected,
      rssBytes: memory.rss,
      heapBytes: memory.heapUsed,
      revision: applied.state.revision,
      hash: applied.state.hash,
    })}\n`,
  );
} else {
  const cols = 4_096;
  const blank = blankTerminalReplicaSnapshot(cols, 1);
  const defaultCell = blank.grid[0]!.cells[0]!;
  const graphemes = ["x".repeat(2_048), "y".repeat(2_048)] as const;
  const row = Object.freeze({
    wrapped: false,
    cells: Object.freeze(
      Array.from({ length: cols }, (_, index) =>
        Object.freeze({ ...defaultCell, grapheme: graphemes[index % 2]! }),
      ),
    ),
  });
  const snapshot = Object.freeze({ ...blank, grid: Object.freeze([row]) });
  const bytes = encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
  const stateHash = hashTerminalReplicaSnapshot(snapshot);
  const representationHash = hashTerminalDeliveryRepresentation(bytes);
  const input = Buffer.allocUnsafe(36 + bytes.byteLength);
  input.writeUInt32BE(bytes.byteLength, 0);
  input.write(stateHash, 4, 16, "ascii");
  input.write(representationHash, 20, 16, "ascii");
  input.set(bytes, 36);
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(import.meta.url), "decode"],
    { input, encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) throw new Error(result.stderr || `max compact child ${result.status}`);
  process.stdout.write(result.stdout);
}
