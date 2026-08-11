import {
  TERMINAL_DELIVERY_CHUNK_BYTES,
  TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES,
  TERMINAL_DELIVERY_PROTOCOL_VERSION,
  TerminalDeliveryEnvelopeSchemaZ,
  TerminalDeliveryChunkSchemaZ,
  TerminalDeliveryNegotiatedSchemaZ,
  TerminalDeliveryNackSchemaZ,
  TerminalSemanticDeliveryPayloadSchemaZ,
  type TerminalDeliveryAck,
  type TerminalDeliveryChunk,
  type TerminalDeliveryEnvelope,
  type TerminalDeliveryNegotiated,
  type TerminalDeliveryNegotiationResult,
  type TerminalDeliveryNack,
  type TerminalDeliveryOffer,
  type TerminalReplicaPatchPayload,
  type TerminalReplicaRow,
  type TerminalReplicaSnapshot,
  type TerminalSemanticDeliveryPayload,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaPatch,
  freezeTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  hashTerminalReplicaTombstone,
  terminalReplicaRowsEqual,
} from "./terminal-replica.ts";

export class TerminalDeliveryStateTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(
      `Terminal delivery representation is ${bytes} bytes; maximum is ${TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES}`,
    );
    this.name = "TerminalDeliveryStateTooLargeError";
    this.bytes = bytes;
  }
}

export function negotiateTerminalDelivery(
  offer: TerminalDeliveryOffer,
  generation: string,
  deliveryNonce: string,
): TerminalDeliveryNegotiationResult {
  if (!offer.protocolVersions.includes(TERMINAL_DELIVERY_PROTOCOL_VERSION))
    return { accepted: false, reason: "protocol-version-mismatch" };
  const encoding = (["semantic-v1", "ansi-diff-v1", "ansi-raw-v1"] as const).find((value) =>
    offer.encodings.includes(value),
  );
  if (!encoding) return { accepted: false, reason: "encoding-mismatch" };
  if (offer.richPlacements && encoding !== "semantic-v1")
    return { accepted: false, reason: "unsupported-capability-combination" };
  return {
    accepted: true,
    negotiated: {
      protocolVersion: TERMINAL_DELIVERY_PROTOCOL_VERSION,
      encoding,
      richPlacements: offer.richPlacements && encoding === "semantic-v1",
      generation,
      deliveryNonce,
    },
  };
}

export function encodeSemanticTerminalUpdate(update: TerminalSemanticDeliveryPayload): Uint8Array {
  const bytes = new TextEncoder().encode(
    canonicalJson(TerminalSemanticDeliveryPayloadSchemaZ.parse(update)),
  );
  assertRepresentationSize(bytes);
  return bytes;
}

export function decodeSemanticTerminalUpdate(bytes: Uint8Array): TerminalSemanticDeliveryPayload {
  assertRepresentationSize(bytes);
  return TerminalSemanticDeliveryPayloadSchemaZ.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export function splitTerminalDeliveryChunks(
  transactionId: string,
  bytes: Uint8Array,
): TerminalDeliveryChunk[] {
  assertRepresentationSize(bytes);
  const chunks: TerminalDeliveryChunk[] = [];
  const count = Math.max(1, Math.ceil(bytes.byteLength / TERMINAL_DELIVERY_CHUNK_BYTES));
  for (let index = 0; index < count; index += 1) {
    chunks.push({
      type: "terminal.delivery.chunk",
      transactionId,
      index,
      bytes: bytes.slice(
        index * TERMINAL_DELIVERY_CHUNK_BYTES,
        Math.min(bytes.byteLength, (index + 1) * TERMINAL_DELIVERY_CHUNK_BYTES),
      ),
    });
  }
  return chunks;
}

export function hashTerminalDeliveryRepresentation(bytes: Uint8Array): string {
  // Two independent 32-bit lanes avoid BigInt's per-byte allocation cost while
  // retaining a deterministic 64-bit wire fingerprint in browser and daemon.
  let high = 0x811c9dc5;
  let low = 0x9e3779b9;
  for (const byte of bytes) {
    high = Math.imul(high ^ byte, 0x01000193) >>> 0;
    low = Math.imul(low ^ byte, 0x85ebca6b) >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

export function diffTerminalReplicaSnapshots(
  baseline: TerminalReplicaSnapshot,
  target: TerminalReplicaSnapshot,
): TerminalReplicaPatchPayload {
  const dimensionsChanged = baseline.cols !== target.cols || baseline.rows !== target.rows;
  const rows = target.grid.flatMap((row, index) =>
    dimensionsChanged || !terminalReplicaRowsEqual(baseline.grid[index], row)
      ? [{ index, row }]
      : [],
  );
  return {
    ...(dimensionsChanged ? { dimensions: { cols: target.cols, rows: target.rows } } : {}),
    rows,
    ...(historyEqual(baseline.history, target.history) ? {} : { history: target.history }),
    cursor: target.cursor,
    modes: target.modes,
    placements: target.placements,
    bootstrap: target.bootstrap,
  };
}

export function encodeAnsiTerminalRepresentation(
  baseline: TerminalReplicaSnapshot | null,
  target: TerminalReplicaSnapshot,
): Uint8Array {
  let output = "";
  if (!baseline || baseline.cols !== target.cols || baseline.rows !== target.rows) {
    output += "\u001b[0m\u001b[2J\u001b[H";
    for (let row = 0; row < target.rows; row += 1) {
      output += renderAnsiRow(target.grid[row]!);
      if (row + 1 < target.rows) output += "\r\n";
    }
  } else {
    for (let row = 0; row < target.rows; row += 1) {
      if (terminalReplicaRowsEqual(baseline.grid[row], target.grid[row]!)) continue;
      output += `\u001b[${row + 1};1H${renderAnsiRow(target.grid[row]!)}\u001b[K`;
    }
  }
  output += `\u001b[${target.cursor.y + 1};${target.cursor.x + 1}H`;
  output += target.cursor.hidden ? "\u001b[?25l" : "\u001b[?25h";
  const bytes = new TextEncoder().encode(output);
  assertRepresentationSize(bytes);
  return bytes;
}

export interface TerminalDeliveryClientState {
  readonly negotiated: TerminalDeliveryNegotiated;
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly incarnation: string | null;
  readonly appliedRevision: number;
  readonly appliedHash: string | null;
  readonly canonicalSnapshot: TerminalReplicaSnapshot | null;
  readonly inFlight: TerminalDeliveryEnvelope | null;
  readonly nextChunk: number;
  readonly receivedBytes: number;
  readonly reseedRequired: boolean;
  readonly failed: boolean;
  readonly tombstoned: boolean;
}

export function createTerminalDeliveryClientState(
  negotiated: TerminalDeliveryNegotiated,
  workspaceName: string,
  semanticPaneId: string,
): TerminalDeliveryClientState {
  return Object.freeze({
    negotiated: Object.freeze(TerminalDeliveryNegotiatedSchemaZ.parse(negotiated)),
    workspaceName,
    semanticPaneId,
    incarnation: null,
    appliedRevision: -1,
    appliedHash: null,
    canonicalSnapshot: null,
    inFlight: null,
    nextChunk: 0,
    receivedBytes: 0,
    reseedRequired: false,
    failed: false,
    tombstoned: false,
  });
}

export function admitTerminalDeliveryEnvelope(
  state: TerminalDeliveryClientState,
  envelope: TerminalDeliveryEnvelope,
): TerminalDeliveryClientState {
  envelope = Object.freeze(TerminalDeliveryEnvelopeSchemaZ.parse(envelope));
  if (
    state.failed ||
    state.inFlight ||
    envelope.encoding !== state.negotiated.encoding ||
    envelope.generation !== state.negotiated.generation ||
    envelope.deliveryNonce !== state.negotiated.deliveryNonce ||
    envelope.protocolVersion !== state.negotiated.protocolVersion ||
    envelope.richPlacements !== state.negotiated.richPlacements ||
    state.workspaceName !== envelope.workspaceName ||
    state.semanticPaneId !== envelope.semanticPaneId
  )
    return failClient(state);
  if (envelope.frame === "seed") {
    if (state.tombstoned && state.incarnation === envelope.incarnation) return failClient(state);
    if (
      state.incarnation === envelope.incarnation &&
      state.appliedRevision >= 0 &&
      envelope.canonicalRevision <= state.appliedRevision
    )
      return failClient(state);
    if (
      state.incarnation !== null &&
      state.incarnation !== envelope.incarnation &&
      (!isNewerIncarnation(state.incarnation, envelope.incarnation) ||
        envelope.canonicalRevision <= state.appliedRevision)
    )
      return failClient(state);
  } else if (
    state.incarnation !== envelope.incarnation ||
    envelope.baseRevision !== state.appliedRevision ||
    state.reseedRequired
  ) {
    return failClient(state);
  }
  if (envelope.frame !== "seed" && state.appliedRevision < 0) return failClient(state);
  return Object.freeze({ ...state, inFlight: envelope, nextChunk: 0, receivedBytes: 0 });
}

export function admitTerminalDeliveryChunk(
  state: TerminalDeliveryClientState,
  chunk: TerminalDeliveryChunk,
): TerminalDeliveryClientState {
  chunk = TerminalDeliveryChunkSchemaZ.parse(chunk);
  const envelope = state.inFlight;
  const expectedBytes = envelope
    ? Math.min(
        TERMINAL_DELIVERY_CHUNK_BYTES,
        Math.max(0, envelope.representationBytes - chunk.index * TERMINAL_DELIVERY_CHUNK_BYTES),
      )
    : -1;
  if (
    state.failed ||
    !state.inFlight ||
    chunk.transactionId !== state.inFlight.transactionId ||
    chunk.index !== state.nextChunk ||
    chunk.index >= state.inFlight.chunkCount ||
    chunk.bytes.byteLength !== expectedBytes ||
    state.receivedBytes + chunk.bytes.byteLength > state.inFlight.representationBytes
  )
    return failClient(state);
  return Object.freeze({
    ...state,
    nextChunk: state.nextChunk + 1,
    receivedBytes: state.receivedBytes + chunk.bytes.byteLength,
  });
}

export class TerminalDeliveryAssembler {
  readonly #buffer: Uint8Array;
  readonly envelope: TerminalDeliveryEnvelope;
  #nextChunk = 0;
  #offset = 0;
  constructor(envelope: TerminalDeliveryEnvelope) {
    this.envelope = Object.freeze(TerminalDeliveryEnvelopeSchemaZ.parse(envelope));
    this.#buffer = new Uint8Array(this.envelope.representationBytes);
  }
  write(chunk: TerminalDeliveryChunk): void {
    chunk = TerminalDeliveryChunkSchemaZ.parse(chunk);
    const expected = Math.min(
      TERMINAL_DELIVERY_CHUNK_BYTES,
      this.envelope.representationBytes - this.#offset,
    );
    if (
      chunk.transactionId !== this.envelope.transactionId ||
      chunk.index !== this.#nextChunk ||
      chunk.bytes.byteLength !== expected
    )
      throw new TypeError("Invalid terminal delivery chunk");
    this.#buffer.set(chunk.bytes, this.#offset);
    this.#offset += chunk.bytes.byteLength;
    this.#nextChunk += 1;
  }
  complete(): Uint8Array {
    if (
      this.#offset !== this.envelope.representationBytes ||
      this.#nextChunk !== this.envelope.chunkCount
    )
      throw new TypeError("Terminal delivery transaction is incomplete");
    if (hashTerminalDeliveryRepresentation(this.#buffer) !== this.envelope.representationHash)
      throw new TypeError("Terminal delivery representation hash mismatch");
    return this.#buffer;
  }
}

export interface StagedTerminalDelivery {
  readonly envelope: TerminalDeliveryEnvelope;
  readonly bytes: Uint8Array;
}

export function completeTerminalDelivery(
  state: TerminalDeliveryClientState,
  assembler: TerminalDeliveryAssembler,
): StagedTerminalDelivery {
  const envelope = state.inFlight;
  if (
    !envelope ||
    state.failed ||
    !sameEnvelope(assembler.envelope, envelope) ||
    state.nextChunk !== envelope.chunkCount ||
    state.receivedBytes !== envelope.representationBytes
  )
    throw new TypeError("Terminal delivery transaction is incomplete");
  return { envelope, bytes: assembler.complete() };
}

export function commitTerminalDelivery(
  state: TerminalDeliveryClientState,
  staged: StagedTerminalDelivery,
  options: { readonly presentationApplied?: boolean } = {},
): { readonly state: TerminalDeliveryClientState; readonly ack: TerminalDeliveryAck } {
  const envelope = state.inFlight;
  if (!envelope || !sameEnvelope(envelope, staged.envelope))
    throw new TypeError("Delivery was not staged from this state");
  if (hashTerminalDeliveryRepresentation(staged.bytes) !== envelope.representationHash)
    throw new TypeError("Terminal delivery representation hash mismatch");
  let canonicalSnapshot = state.canonicalSnapshot;
  if (envelope.encoding === "semantic-v1") {
    const payload = decodeSemanticTerminalUpdate(staged.bytes);
    if (payload.frame !== envelope.frame || payload.revision !== envelope.canonicalRevision)
      throw new TypeError("Semantic frame or revision mismatch");
    if (
      payload.frame !== "seed" &&
      (payload.baseRevision !== envelope.baseRevision ||
        payload.baseRevision !== state.appliedRevision)
    )
      throw new TypeError("Semantic delivery baseline gap");
    if (payload.frame === "seed")
      canonicalSnapshot = freezeTerminalReplicaSnapshot(payload.snapshot);
    else if (payload.frame === "patch") {
      if (!canonicalSnapshot) throw new TypeError("Semantic delivery baseline gap");
      canonicalSnapshot = applyTerminalReplicaPatch(canonicalSnapshot, payload.patch);
    } else canonicalSnapshot = null;
    const hash = canonicalSnapshot
      ? hashTerminalReplicaSnapshot(canonicalSnapshot)
      : hashTerminalReplicaTombstone(
          payload.frame === "tombstone" ? payload.tombstone.reason : "protocol",
        );
    if (hash !== envelope.canonicalStateHash) throw new TypeError("Canonical state hash mismatch");
  } else if (!options.presentationApplied) {
    throw new TypeError("ANSI presentation must be applied before ACK");
  }
  const next = Object.freeze({
    ...state,
    workspaceName: envelope.workspaceName,
    semanticPaneId: envelope.semanticPaneId,
    incarnation: envelope.incarnation,
    appliedRevision: envelope.canonicalRevision,
    appliedHash: envelope.canonicalStateHash,
    canonicalSnapshot,
    tombstoned: envelope.frame === "tombstone",
    inFlight: null,
    nextChunk: 0,
    receivedBytes: 0,
    reseedRequired: false,
  });
  return {
    state: next,
    ack: {
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
    },
  };
}

export function nackTerminalDelivery(
  state: TerminalDeliveryClientState,
  nack: TerminalDeliveryNack,
): TerminalDeliveryClientState {
  nack = TerminalDeliveryNackSchemaZ.parse(nack);
  if (
    nack.generation !== state.negotiated.generation ||
    nack.deliveryNonce !== state.negotiated.deliveryNonce ||
    nack.workspaceName !== state.workspaceName ||
    nack.semanticPaneId !== state.semanticPaneId
  )
    return failClient(state);
  if (state.inFlight && nack.transactionId !== state.inFlight.transactionId)
    return failClient(state);
  return Object.freeze({
    ...state,
    inFlight: null,
    nextChunk: 0,
    receivedBytes: 0,
    reseedRequired: true,
    failed: false,
  });
}

function failClient(state: TerminalDeliveryClientState): TerminalDeliveryClientState {
  return Object.freeze({ ...state, failed: true, inFlight: null, receivedBytes: 0 });
}

function sameEnvelope(left: TerminalDeliveryEnvelope, right: TerminalDeliveryEnvelope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function historyEqual(
  left: readonly TerminalReplicaRow[],
  right: readonly TerminalReplicaRow[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((row, index) => terminalReplicaRowsEqual(row, right[index]!)))
  );
}

function renderAnsiRow(row: TerminalReplicaRow): string {
  let output = "\u001b[0m";
  for (const cell of row.cells) {
    if (cell.width === 0) continue;
    output += ansiCellStyle(cell);
    output += cell.grapheme;
  }
  return `${output}\u001b[0m`;
}

function ansiCellStyle(cell: TerminalReplicaRow["cells"][number]): string {
  const codes: number[] = [0];
  if (cell.attributes & 1) codes.push(1);
  if (cell.attributes & 2) codes.push(2);
  if (cell.attributes & 4) codes.push(3);
  if (cell.attributes & 8) codes.push(4);
  if (cell.attributes & 32) codes.push(7);
  if (cell.attributes & 128) codes.push(9);
  if (cell.foreground.kind === "indexed") codes.push(38, 5, cell.foreground.index);
  if (cell.foreground.kind === "rgb")
    codes.push(
      38,
      2,
      (cell.foreground.value >> 16) & 255,
      (cell.foreground.value >> 8) & 255,
      cell.foreground.value & 255,
    );
  if (cell.background.kind === "indexed") codes.push(48, 5, cell.background.index);
  if (cell.background.kind === "rgb")
    codes.push(
      48,
      2,
      (cell.background.value >> 16) & 255,
      (cell.background.value >> 8) & 255,
      cell.background.value & 255,
    );
  return `\u001b[${codes.join(";")}m`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function assertRepresentationSize(bytes: Uint8Array): void {
  if (bytes.byteLength > TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES)
    throw new TerminalDeliveryStateTooLargeError(bytes.byteLength);
}

function isNewerIncarnation(current: string, candidate: string): boolean {
  const currentEpoch = /:([0-9]+)$/u.exec(current)?.[1];
  const candidateEpoch = /:([0-9]+)$/u.exec(candidate)?.[1];
  return (
    currentEpoch !== undefined &&
    candidateEpoch !== undefined &&
    Number(candidateEpoch) > Number(currentEpoch)
  );
}
