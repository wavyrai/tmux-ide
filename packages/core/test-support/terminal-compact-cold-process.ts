import {
  applyTerminalReplicaUpdate,
  applyTerminalReplicaPatch,
  blankTerminalReplicaSnapshot,
  decodeVerifiedCompactSemanticTerminalUpdateCooperatively,
  encodeCompactSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  type CompactSemanticCommitProfile,
  type TerminalReplicaState,
} from "../src/index.ts";

const cols = 132;
const rows = 41;
const blank = blankTerminalReplicaSnapshot(cols, rows);
const defaultCell = blank.grid[0]!.cells[0]!;
const uniqueRow = (ordinal: number) => {
  const prefix = `workload-${String(ordinal).padStart(4, "0")}`;
  return Object.freeze({
    wrapped: false,
    cells: Object.freeze([
      ...[...prefix].map((grapheme) => Object.freeze({ ...defaultCell, grapheme })),
      ...Array.from({ length: cols - prefix.length }, () => defaultCell),
    ]),
  });
};
const initialHistory = Object.freeze(Array.from({ length: 4_096 }, (_, index) => uniqueRow(index)));
const appendedHistory = Object.freeze(
  Array.from({ length: 904 }, (_, index) => uniqueRow(4_096 + index)),
);
const canonical = Object.freeze({ ...blank, history: initialHistory });
const moved = applyTerminalReplicaPatch(canonical, {
  rows: [],
  historyDelta: { trim: 0, append: appendedHistory },
  cursor: Object.freeze({ ...canonical.cursor, x: 1 }),
});

const seedPayload = Object.freeze({ frame: "seed" as const, revision: 0, snapshot: canonical });
const patchPayload = Object.freeze({
  frame: "patch" as const,
  baseRevision: 0,
  revision: 1,
  patch: Object.freeze({
    rows: Object.freeze([]),
    historyDelta: Object.freeze({ trim: 0, append: appendedHistory }),
    cursor: Object.freeze({ ...canonical.cursor, x: 1 }),
  }),
});

const deliveries = [
  {
    revision: 0,
    bytes: encodeCompactSemanticTerminalUpdate(seedPayload),
    stateHash: hashTerminalReplicaSnapshot(canonical),
  },
  {
    revision: 1,
    bytes: encodeCompactSemanticTerminalUpdate(patchPayload),
    stateHash: hashTerminalReplicaSnapshot(moved),
  },
] as const;
let state: TerminalReplicaState | null = null;
const profiles: CompactSemanticCommitProfile[] = [];
const started = performance.now();
let sliceAt = performance.now();
let sliceCpu = process.cpuUsage();
let maxSliceWallMs = 0;
let maxSliceCpuMs = 0;
let maxSliceStage = "";
let yieldCount = 0;
const recordSlice = (stage: string): void => {
  const wallMs = performance.now() - sliceAt;
  const cpu = process.cpuUsage(sliceCpu);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  if (wallMs > maxSliceWallMs) {
    maxSliceWallMs = wallMs;
    maxSliceStage =
      stage === "decode-yield"
        ? (new Error().stack?.split("\n").slice(3, 7).join("\n") ?? stage)
        : stage;
  }
  maxSliceCpuMs = Math.max(maxSliceCpuMs, cpuMs);
  sliceAt = performance.now();
  sliceCpu = process.cpuUsage();
};
const yieldControl = async (): Promise<void> => {
  recordSlice("decode-yield");
  yieldCount++;
  await new Promise<void>((resolve) => setImmediate(resolve));
  sliceAt = performance.now();
  sliceCpu = process.cpuUsage();
};
let timerDelayMs = 0;
let heartbeatActive = true;
let heartbeatAt = performance.now();
let heartbeatCpu = process.cpuUsage();
let maxHeartbeatCpuMs = 0;
let maxHeartbeatWallCpuMs = 0;
const heartbeat = (): void => {
  const now = performance.now();
  const cpu = process.cpuUsage(heartbeatCpu);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  if (now - heartbeatAt > timerDelayMs) maxHeartbeatWallCpuMs = cpuMs;
  maxHeartbeatCpuMs = Math.max(maxHeartbeatCpuMs, cpuMs);
  timerDelayMs = Math.max(timerDelayMs, now - heartbeatAt);
  heartbeatCpu = process.cpuUsage();
  heartbeatAt = now;
  if (heartbeatActive) setImmediate(heartbeat);
};
setImmediate(heartbeat);
for (const { revision, bytes, stateHash } of deliveries) {
  const verified = await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
    bytes,
    state?.snapshot ?? null,
    stateHash,
    {
      grantReducerAdoption: true,
      yieldControl,
      onComplete: (profile) => profiles.push(profile),
    },
  );
  if (verified.payload.frame !== (revision === 0 ? "seed" : "patch"))
    throw new Error("cold compact frame mismatch");
  recordSlice("decode-return");
  const applied = applyTerminalReplicaUpdate(
    state,
    verified.payload.frame === "seed"
      ? {
          type: "terminal.seed",
          workspaceName: "cold",
          semanticPaneId: "pane-a",
          generation: "00000000-0000-4000-8000-000000000001",
          incarnation: "00000000-0000-4000-8000-000000000001:0",
          revision,
          cols: verified.canonicalSnapshot!.cols,
          rows: verified.canonicalSnapshot!.rows,
          stateHash,
          hashAlgorithm: "fnv1a64-v1",
          snapshot: verified.payload.snapshot,
        }
      : {
          type: "terminal.patch",
          workspaceName: "cold",
          semanticPaneId: "pane-a",
          generation: "00000000-0000-4000-8000-000000000001",
          incarnation: "00000000-0000-4000-8000-000000000001:0",
          baseRevision: verified.payload.baseRevision,
          revision,
          cols: verified.canonicalSnapshot!.cols,
          rows: verified.canonicalSnapshot!.rows,
          stateHash,
          hashAlgorithm: "fnv1a64-v1",
          patch: verified.payload.patch,
        },
    { authenticatedFrameHash: hashTerminalDeliveryRepresentation(bytes) },
  );
  if (applied.status !== "applied") throw new Error(`cold compact ${applied.status}`);
  if (applied.state.snapshot !== verified.canonicalSnapshot)
    throw new Error("cold compact snapshot was cloned");
  state = applied.state;
  recordSlice("representation-hash-and-adoption");
}
await new Promise<void>((resolve) => setImmediate(resolve));
heartbeatActive = false;
const memory = process.memoryUsage();
process.stdout.write(
  `${JSON.stringify({
    node: process.version,
    architecture: process.arch,
    maxSliceWallMs,
    maxSliceCpuMs,
    maxSliceStage,
    yieldCount,
    maxHeartbeatCpuMs,
    maxHeartbeatWallCpuMs,
    durationMs: performance.now() - started,
    timerDelayMs,
    rssBytes: memory.rss,
    heapBytes: memory.heapUsed,
    profiles,
    uniqueHistoryRows: new Set(moved.history).size,
    revision: state.revision,
    hash: state.hash,
  })}\n`,
);
