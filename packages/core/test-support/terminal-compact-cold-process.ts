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
let timerDelayMs = 0;
let heartbeatActive = true;
let heartbeatAt = performance.now();
const heartbeat = (): void => {
  const now = performance.now();
  timerDelayMs = Math.max(timerDelayMs, now - heartbeatAt);
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
      yieldControl: () => new Promise<void>((resolve) => setImmediate(resolve)),
      onComplete: (profile) => profiles.push(profile),
    },
  );
  if (verified.payload.frame !== (revision === 0 ? "seed" : "patch"))
    throw new Error("cold compact frame mismatch");
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
}
await new Promise<void>((resolve) => setImmediate(resolve));
heartbeatActive = false;
const memory = process.memoryUsage();
process.stdout.write(
  `${JSON.stringify({
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
