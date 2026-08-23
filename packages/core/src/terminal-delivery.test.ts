import { describe, expect, it } from "vitest";
import {
  TerminalDeliveryEnvelopeSchemaZ,
  type TerminalDeliveryEnvelope,
  type TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  decodeCompactSemanticTerminalUpdate,
  decodeSemanticTerminalUpdate,
  decodeVerifiedCompactSemanticTerminalUpdate,
  decodeVerifiedCompactSemanticTerminalUpdateCooperatively,
  encodeAnsiTerminalPatchRepresentation,
  encodeAnsiTerminalRepresentation,
  encodeCompactSemanticTerminalUpdate,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  nackTerminalDelivery,
  preaccountSemanticTerminalUpdateBytes,
  splitTerminalDeliveryChunks,
  TerminalDeliveryAssembler,
  TerminalDeliveryStateTooLargeError,
  type CompactSemanticCommitProfile,
} from "./index.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const tx = "00000000-0000-4000-8000-000000000003";

function seedEnvelope(): { envelope: TerminalDeliveryEnvelope; bytes: Uint8Array } {
  const snapshot = blankTerminalReplicaSnapshot(2, 1);
  const bytes = encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
  return {
    bytes,
    envelope: TerminalDeliveryEnvelopeSchemaZ.parse({
      type: "terminal.delivery",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      deliveryNonce: nonce,
      transactionId: tx,
      protocolVersion: 1,
      encoding: "semantic-v1",
      frame: "seed",
      baseRevision: null,
      canonicalRevision: 0,
      canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.byteLength,
      chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
      canonicalEquivalent: true,
      history: "complete",
      richPlacements: false,
    }),
  };
}

describe("terminal delivery client", () => {
  it("encodes ordinary ANSI deltas from dirty rows without inspecting the full grid", () => {
    const snapshot = blankTerminalReplicaSnapshot(4, 3);
    const inaccessibleGrid = new Proxy(snapshot.grid, {
      get() {
        throw new Error("unchanged grid row was inspected");
      },
    });
    const target = { ...snapshot, grid: inaccessibleGrid };
    const bytes = encodeAnsiTerminalPatchRepresentation(
      { rows: [{ index: 1, row: snapshot.grid[1]! }] },
      target,
      snapshot,
    );
    expect(new TextDecoder().decode(bytes)).toContain("\u001b[2;1H");
  });
  it("encodes cursor-only patches without a grid walk and preserves DECSCUSR", () => {
    const baseline = blankTerminalReplicaSnapshot(4, 3);
    const inaccessibleGrid = new Proxy(baseline.grid, {
      get() {
        throw new Error("cursor-only patch inspected the grid");
      },
    });
    const target = {
      ...baseline,
      grid: inaccessibleGrid,
      cursor: { x: 2, y: 1, hidden: false, style: "bar" as const, blink: false },
    };
    const output = new TextDecoder().decode(
      encodeAnsiTerminalPatchRepresentation({ rows: [], cursor: target.cursor }, target, baseline),
    );
    expect(output).toBe("\u001b[2;3H\u001b[6 q\u001b[?25h");
  });

  it("restores the canonical wraparound mode after row painting and mode-only patches", () => {
    const baseline = blankTerminalReplicaSnapshot(4, 3);
    const target = {
      ...baseline,
      modes: { ...baseline.modes, wraparound: false },
    };
    const modeOnly = new TextDecoder().decode(
      encodeAnsiTerminalPatchRepresentation({ rows: [], modes: target.modes }, target, baseline),
    );
    expect(modeOnly.startsWith("\u001b[?7l")).toBe(true);
    const painted = new TextDecoder().decode(encodeAnsiTerminalRepresentation(null, target));
    expect(painted).toContain("\u001b[?7h");
    expect(painted.lastIndexOf("\u001b[?7l")).toBeGreaterThan(painted.lastIndexOf("\u001b[?7h"));
  });

  it("uses an exact buffer repaint when a dirty row changes soft-wrap topology", () => {
    const baseline = blankTerminalReplicaSnapshot(4, 3);
    const wrappedRow = { ...baseline.grid[1]!, wrapped: true };
    const wrapped = { ...baseline, grid: [baseline.grid[0]!, wrappedRow, baseline.grid[2]!] };
    const enter = new TextDecoder().decode(
      encodeAnsiTerminalPatchRepresentation(
        { rows: [{ index: 1, row: wrappedRow }] },
        wrapped,
        baseline,
      ),
    );
    const leave = new TextDecoder().decode(
      encodeAnsiTerminalPatchRepresentation(
        { rows: [{ index: 1, row: baseline.grid[1]! }] },
        baseline,
        wrapped,
      ),
    );
    expect(enter.startsWith("\u001b[?1049l\u001b[0m\u001b[2J\u001b[H")).toBe(true);
    expect(leave.startsWith("\u001b[?1049l\u001b[0m\u001b[2J\u001b[H")).toBe(true);
  });

  it("switches 1049 buffers before a full baseline-aware repaint and restores normal exactly", () => {
    const normal = blankTerminalReplicaSnapshot(2, 1);
    const alternate = { ...normal, modes: { ...normal.modes, alternateScreen: true } };
    const enter = new TextDecoder().decode(
      encodeAnsiTerminalPatchRepresentation(
        { rows: [], modes: alternate.modes },
        alternate,
        normal,
      ),
    );
    const leave = new TextDecoder().decode(
      encodeAnsiTerminalPatchRepresentation({ rows: [], modes: normal.modes }, normal, alternate),
    );
    expect(enter.startsWith("\u001b[?1049h\u001b[0m\u001b[2J\u001b[H")).toBe(true);
    expect(leave.startsWith("\u001b[?1049l\u001b[0m\u001b[2J\u001b[H")).toBe(true);
  });

  it("enters 1049 before a seed that begins in the alternate buffer", () => {
    const normal = blankTerminalReplicaSnapshot(2, 1);
    const alternate = { ...normal, modes: { ...normal.modes, alternateScreen: true } };
    const output = new TextDecoder().decode(encodeAnsiTerminalRepresentation(null, alternate));
    expect(output.startsWith("\u001b[?1049h\u001b[0m\u001b[2J\u001b[H")).toBe(true);
  });
  it("exits 1049 before a normal seed and encodes every DECSCUSR visibility combination", () => {
    const baseline = blankTerminalReplicaSnapshot(2, 1);
    const seed = new TextDecoder().decode(encodeAnsiTerminalRepresentation(null, baseline));
    expect(seed.startsWith("\u001b[?1049l\u001b[0m\u001b[2J\u001b[H")).toBe(true);
    const expected = [
      ["block", true, 1],
      ["block", false, 2],
      ["underline", true, 3],
      ["underline", false, 4],
      ["bar", true, 5],
      ["bar", false, 6],
    ] as const;
    for (const [style, blink, shape] of expected) {
      const target = { ...baseline, cursor: { x: 0, y: 0, hidden: true, style, blink } };
      const output = new TextDecoder().decode(
        encodeAnsiTerminalPatchRepresentation(
          { rows: [], cursor: target.cursor },
          target,
          baseline,
        ),
      );
      expect(output).toBe(`\u001b[1;1H\u001b[${shape} q\u001b[?25l`);
    }
  });
  it("negotiates deterministically and rejects unsupported rich ANSI", () => {
    expect(
      negotiateTerminalDelivery(
        {
          protocolVersions: [1],
          encodings: ["semantic-v1", "semantic-compact-v1"],
          richPlacements: true,
        },
        generation,
        nonce,
      ),
    ).toMatchObject({
      accepted: true,
      negotiated: {
        encoding: "semantic-compact-v1",
        fallbackEncoding: "semantic-v1",
        richPlacements: true,
      },
    });
    expect(
      negotiateTerminalDelivery(
        { protocolVersions: [2], encodings: ["semantic-v1"], richPlacements: false },
        generation,
        nonce,
      ),
    ).toEqual({ accepted: false, reason: "protocol-version-mismatch" });
    expect(
      negotiateTerminalDelivery(
        { protocolVersions: [1], encodings: ["ansi-diff-v1"], richPlacements: true },
        generation,
        nonce,
      ),
    ).toEqual({ accepted: false, reason: "unsupported-capability-combination" });
    const compactOnly = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-compact-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!compactOnly.accepted) throw new Error("compact-only negotiation failed");
    expect(
      admitTerminalDeliveryEnvelope(
        createTerminalDeliveryClientState(compactOnly.negotiated, "workspace", "pane-a"),
        seedEnvelope().envelope,
      ).failed,
    ).toBe(true);
  });

  it("roundtrips every canonical semantic field through compact v1", () => {
    const blank = blankTerminalReplicaSnapshot(4, 2);
    const styled = {
      cells: [
        {
          grapheme: "界",
          width: 2 as const,
          foreground: { kind: "indexed" as const, index: 196 },
          background: { kind: "rgb" as const, value: 0x010203 },
          attributes: 0x7f,
        },
        {
          grapheme: "",
          width: 0 as const,
          foreground: { kind: "indexed" as const, index: 196 },
          background: { kind: "rgb" as const, value: 0x010203 },
          attributes: 0x7f,
        },
        {
          grapheme: "é",
          width: 1 as const,
          foreground: { kind: "default" as const },
          background: { kind: "default" as const },
          attributes: 3,
        },
        blank.grid[0]!.cells[3]!,
      ],
      wrapped: true,
    };
    const snapshot = {
      ...blank,
      grid: [styled, blank.grid[1]!],
      history: [styled],
      cursor: { x: 2, y: 1, hidden: true, style: "bar" as const, blink: true },
      modes: {
        ...blank.modes,
        alternateScreen: true,
        applicationCursor: true,
        mouseTracking: true,
        mouseProtocol: "drag" as const,
        mouseEncoding: "sgr" as const,
      },
      placements: [
        {
          id: "placement-a",
          kind: "image",
          row: 0,
          column: 1,
          columns: 2,
          rows: 1,
          contentDigest: "digest-a",
        },
      ],
      bootstrap: {
        kind: "authoritative-stream" as const,
        hiddenState: "observed-from-start" as const,
      },
    };
    const seed = { frame: "seed" as const, revision: 7, snapshot };
    const encoded = encodeCompactSemanticTerminalUpdate(seed);
    expect(decodeCompactSemanticTerminalUpdate(encoded)).toEqual(seed);
    const patch = {
      frame: "patch" as const,
      baseRevision: 7,
      revision: 8,
      patch: {
        rows: [{ index: 0, row: styled }],
        historyDelta: { trim: 1, append: [styled] },
        cursor: snapshot.cursor,
        modes: snapshot.modes,
        placements: snapshot.placements,
        bootstrap: snapshot.bootstrap,
      },
    };
    expect(decodeCompactSemanticTerminalUpdate(encodeCompactSemanticTerminalUpdate(patch))).toEqual(
      patch,
    );
  });

  it("deep-freezes compact decodes and adopts only the decoder-owned verified snapshot", () => {
    const blank = blankTerminalReplicaSnapshot(3, 2);
    const historyRow = {
      cells: blank.grid[0]!.cells.map((cell, index) => ({
        ...cell,
        grapheme: index === 0 ? "界" : index === 1 ? "" : "é",
        width: (index === 0 ? 2 : index === 1 ? 0 : 1) as 0 | 1 | 2,
        foreground: { kind: "indexed" as const, index: 17 },
        background: { kind: "rgb" as const, value: 0x010203 },
      })),
      wrapped: true,
    };
    const snapshot = { ...blank, history: [historyRow] };
    const bytes = encodeCompactSemanticTerminalUpdate({
      frame: "seed",
      revision: 0,
      snapshot,
    });
    const publicDecode = decodeCompactSemanticTerminalUpdate(bytes);
    if (publicDecode.frame !== "seed") throw new Error("expected compact seed");
    expect(Object.isFrozen(publicDecode)).toBe(true);
    expect(Object.isFrozen(publicDecode.snapshot)).toBe(true);
    expect(Object.isFrozen(publicDecode.snapshot.history)).toBe(true);
    expect(Object.isFrozen(publicDecode.snapshot.history[0]!.cells)).toBe(true);
    expect(Object.isFrozen(publicDecode.snapshot.history[0]!.cells[0]!.foreground)).toBe(true);
    expect(() => {
      publicDecode.snapshot.history[0]!.cells[0]!.grapheme = "forged";
    }).toThrow();
    let forgedProfile: unknown = null;
    const ordinary = applyTerminalReplicaUpdate(
      null,
      {
        type: "terminal.seed",
        workspaceName: "workspace",
        semanticPaneId: "pane-a",
        generation,
        incarnation: `${generation}:0`,
        revision: 0,
        cols: snapshot.cols,
        rows: snapshot.rows,
        stateHash: hashTerminalReplicaSnapshot(snapshot),
        hashAlgorithm: "fnv1a64-v1",
        snapshot: publicDecode.snapshot,
      },
      {
        instrumentation: { nowMicros: () => 1, onComplete: (profile) => (forgedProfile = profile) },
      },
    );
    if (ordinary.status !== "applied") throw new Error("ordinary seed rejected");
    expect(ordinary.state.snapshot).not.toBe(publicDecode.snapshot);
    expect(forgedProfile).toMatchObject({ trustedCompactAdoption: false });
    let compactProfile: unknown = null;
    const verified = decodeVerifiedCompactSemanticTerminalUpdate(
      bytes,
      null,
      hashTerminalReplicaSnapshot(snapshot),
      { onComplete: (profile) => (compactProfile = profile) },
    );
    expect(verified.canonicalSnapshot).toBe(
      verified.payload.frame === "seed" ? verified.payload.snapshot : null,
    );
    expect(compactProfile).toMatchObject({
      expandedRows: 3,
      expandedCells: 9,
      schemaTraversals: 1,
      hashTraversals: 1,
      applyTraversals: 0,
      trustedAdoption: true,
      retainedSnapshots: 0,
    });

    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-compact-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("compact negotiation failed");
    const envelope = TerminalDeliveryEnvelopeSchemaZ.parse({
      ...seedEnvelope().envelope,
      encoding: "semantic-compact-v1",
      canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.byteLength,
      chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
    });
    let state = admitTerminalDeliveryEnvelope(
      createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a"),
      envelope,
    );
    if (!state.inFlight) throw new Error("compact seed was not admitted");
    const assembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(tx, bytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      assembler.write(chunk);
    }
    const committed = commitTerminalDelivery(state, completeTerminalDelivery(state, assembler));
    if (committed.semanticUpdate?.frame !== "seed") throw new Error("compact seed missing");
    expect(committed.state.canonicalSnapshot).toBe(committed.semanticUpdate.snapshot);
    expect(committed.state.canonicalSnapshot?.history[0]?.cells[0]?.foreground).toBe(
      committed.semanticUpdate.snapshot.history[0]?.cells[0]?.foreground,
    );

    const appended = { ...historyRow, wrapped: false };
    const patch = {
      frame: "patch" as const,
      baseRevision: 0,
      revision: 1,
      patch: { rows: [], historyDelta: { trim: 1, append: [appended] } },
    };
    const patchBytes = encodeCompactSemanticTerminalUpdate(patch);
    const target = { ...snapshot, history: [appended] };
    const patchEnvelope = TerminalDeliveryEnvelopeSchemaZ.parse({
      ...envelope,
      transactionId: "00000000-0000-4000-8000-000000000004",
      frame: "patch",
      baseRevision: 0,
      canonicalRevision: 1,
      canonicalStateHash: hashTerminalReplicaSnapshot(target),
      representationHash: hashTerminalDeliveryRepresentation(patchBytes),
      representationBytes: patchBytes.byteLength,
      chunkCount: Math.max(1, Math.ceil(patchBytes.byteLength / (256 * 1024))),
    });
    state = admitTerminalDeliveryEnvelope(committed.state, patchEnvelope);
    if (!state.inFlight) throw new Error("compact patch was not admitted");
    const patchAssembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(patchEnvelope.transactionId, patchBytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      patchAssembler.write(chunk);
    }
    const patched = commitTerminalDelivery(state, completeTerminalDelivery(state, patchAssembler));
    if (patched.semanticUpdate?.frame !== "patch") throw new Error("compact patch missing");
    expect(patched.state.canonicalSnapshot?.history[0]).toBe(
      patched.semanticUpdate.patch.historyDelta?.append[0],
    );
    expect(patched.state.canonicalSnapshot?.history[0]?.cells[0]).toBe(
      patched.semanticUpdate.patch.historyDelta?.append[0]?.cells[0],
    );
  });

  it("keeps a real-width five-thousand-row semantic seed below the unchanged cap", () => {
    const blank = blankTerminalReplicaSnapshot(132, 40);
    const row = {
      cells: blank.grid[0]!.cells.map((cell, index) =>
        index < 28 ? { ...cell, grapheme: String.fromCharCode(65 + (index % 26)) } : cell,
      ),
      wrapped: false,
    };
    const snapshot = { ...blank, history: Array.from({ length: 5_000 }, () => row) };
    const bytes = encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 1, snapshot });
    expect(bytes.byteLength).toBeLessThan(16 * 1024 * 1024);
    expect(decodeCompactSemanticTerminalUpdate(bytes)).toEqual({
      frame: "seed",
      revision: 1,
      snapshot,
    });
  }, 30_000);

  it("reuses authenticated baseline rows before allocating repeated compact history", async () => {
    const blank = blankTerminalReplicaSnapshot(132, 41);
    const defaultCell = blank.grid[0]!.cells[0]!;
    const history = Object.freeze(
      Array.from({ length: 4_096 }, (_, ordinal) => {
        const prefix = `LOAD_${String(ordinal).padStart(4, "0")} 0123456789abcdef`;
        return Object.freeze({
          wrapped: false,
          cells: Object.freeze([
            ...[...prefix].map((grapheme) => Object.freeze({ ...defaultCell, grapheme })),
            ...Array.from({ length: 132 - prefix.length }, () => defaultCell),
          ]),
        });
      }),
    ) as unknown as TerminalReplicaSnapshot["history"];
    const seedSnapshot = Object.freeze({ ...blank, history }) as TerminalReplicaSnapshot;
    const seedBytes = encodeCompactSemanticTerminalUpdate({
      frame: "seed",
      revision: 0,
      snapshot: seedSnapshot,
    });
    const yieldControl = () => new Promise<void>((resolve) => setImmediate(resolve));
    const seed = await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
      seedBytes,
      null,
      hashTerminalReplicaSnapshot(seedSnapshot),
      { yieldControl },
    );
    if (!seed.canonicalSnapshot) throw new Error("compact reuse seed missing");

    const patchPayload = {
      frame: "patch" as const,
      baseRevision: 0,
      revision: 1,
      patch: { rows: [], historyDelta: { trim: history.length, append: history } },
    };
    const patchBytes = encodeCompactSemanticTerminalUpdate(patchPayload);
    let profile: CompactSemanticCommitProfile | null = null;
    const repeated = await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
      patchBytes,
      seed.canonicalSnapshot,
      hashTerminalReplicaSnapshot(seed.canonicalSnapshot),
      { yieldControl, onComplete: (value) => (profile = value) },
    );
    expect(profile).toMatchObject({
      expandedRows: 4_096,
      expandedCells: 540_672,
      reusedRows: 4_096,
      allocatedCells: 0,
    });
    expect(repeated.canonicalSnapshot?.history[2_048]).toBe(seed.canonicalSnapshot.history[2_048]);

    const changedCells = [...history[2_048]!.cells];
    changedCells[0] = Object.freeze({ ...changedCells[0]!, grapheme: "X" });
    const changed = Object.freeze({
      ...history[2_048]!,
      cells: Object.freeze(changedCells),
    }) as TerminalReplicaSnapshot["history"][number];
    const changedHistory = Object.freeze([
      ...history.slice(0, 2_048),
      changed,
      ...history.slice(2_049),
    ]) as unknown as TerminalReplicaSnapshot["history"];
    const changedPayload = {
      frame: "patch" as const,
      baseRevision: 1,
      revision: 2,
      patch: {
        rows: [],
        historyDelta: { trim: changedHistory.length, append: changedHistory },
      },
    };
    const changedBytes = encodeCompactSemanticTerminalUpdate(changedPayload);
    const changedTarget = Object.freeze({
      ...repeated.canonicalSnapshot!,
      history: changedHistory,
    }) as TerminalReplicaSnapshot;
    profile = null;
    const changedResult = await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
      changedBytes,
      repeated.canonicalSnapshot,
      hashTerminalReplicaSnapshot(changedTarget),
      { yieldControl, onComplete: (value) => (profile = value) },
    );
    expect(profile).toMatchObject({ reusedRows: 4_095, allocatedCells: 132 });
    expect(changedResult.canonicalSnapshot?.history[2_048]).not.toBe(
      repeated.canonicalSnapshot?.history[2_048],
    );
    expect(changedResult.canonicalSnapshot?.history[2_048]).toEqual(changed);
  }, 30_000);

  it("keeps only row-level reuse across 100 distinct history sequences", async () => {
    const blank = blankTerminalReplicaSnapshot(132, 41);
    const baseRow = blank.grid[0]!;
    let target = Object.freeze({
      ...blank,
      history: Object.freeze(Array.from({ length: 8 }, () => baseRow)),
    }) as TerminalReplicaSnapshot;
    const yieldControl = () => new Promise<void>((resolve) => setImmediate(resolve));
    const seed = await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
      encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot: target }),
      null,
      hashTerminalReplicaSnapshot(target),
      { yieldControl },
    );
    let current = seed.canonicalSnapshot!;
    for (let revision = 1; revision <= 100; revision += 1) {
      const cells = [...baseRow.cells];
      cells[0] = Object.freeze({ ...cells[0]!, grapheme: String.fromCodePoint(0x100 + revision) });
      const changed = Object.freeze({ ...baseRow, cells: Object.freeze(cells) });
      const history = Object.freeze([changed, ...Array.from({ length: 7 }, () => baseRow)]);
      const patch = Object.freeze({
        rows: [],
        history: history as TerminalReplicaSnapshot["history"],
      });
      target = Object.freeze({ ...current, history }) as TerminalReplicaSnapshot;
      let profile: CompactSemanticCommitProfile | null = null;
      const decoded = await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
        encodeCompactSemanticTerminalUpdate({
          frame: "patch",
          baseRevision: revision - 1,
          revision,
          patch,
        }),
        current,
        hashTerminalReplicaSnapshot(target),
        { yieldControl, onComplete: (value) => (profile = value) },
      );
      expect(profile).toMatchObject({ reusedRows: 7, allocatedCells: 132 });
      expect(decoded.canonicalSnapshot?.history).toEqual(history);
      current = decoded.canonicalSnapshot!;
    }
  }, 30_000);

  it("rejects unknown, malformed, over-wide and expansion-bomb compact payloads", () => {
    const snapshot = blankTerminalReplicaSnapshot(2, 1);
    const bytes = encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
    const wire: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const root = (value: unknown) => value as Record<string, unknown>;
    const at = (value: unknown, ...indices: number[]): unknown[] => {
      let current = value;
      for (const index of indices) current = (current as unknown[])[index];
      return current as unknown[];
    };
    for (const mutate of [
      (value: unknown) => (root(value).v = 2),
      (value: unknown) => (root(value).extra = true),
      (value: unknown) => (at(root(value).s)[0] = 4_097),
      (value: unknown) => (at(root(value).s, 2, 0, 1, 0)[0] = 4_097),
      (value: unknown) => at(root(value).s, 2, 0, 1).push([10_000_000, " ", 1, 0, 0, 0]),
    ]) {
      const candidate = structuredClone(wire);
      mutate(candidate);
      expect(() =>
        decodeCompactSemanticTerminalUpdate(new TextEncoder().encode(JSON.stringify(candidate))),
      ).toThrow();
    }
    const aggregateBomb = structuredClone(wire);
    root(aggregateBomb).s = [
      4_096,
      1,
      [[0, [[4_096, " ", 1, 0, 0, 0]]]],
      Array.from({ length: 244 }, () => [0, [[4_096, " ", 1, 0, 0, 0]]]),
      [0, 0, 0, "block", 0],
      at(root(wire).s, 5),
      [],
      at(root(wire).s, 7),
    ];
    const aggregateBytes = new TextEncoder().encode(JSON.stringify(aggregateBomb));
    expect(aggregateBytes.byteLength).toBeLessThan(64 * 1024);
    expect(() => decodeCompactSemanticTerminalUpdate(aggregateBytes)).toThrow(
      "Compact semantic expanded cell budget exceeded",
    );
    const oversizedString = {
      ...snapshot,
      grid: [
        {
          ...snapshot.grid[0]!,
          cells: [
            { ...snapshot.grid[0]!.cells[0]!, grapheme: "x".repeat(4_097) },
            snapshot.grid[0]!.cells[1]!,
          ],
        },
      ],
    };
    expect(() =>
      encodeCompactSemanticTerminalUpdate({
        frame: "seed",
        revision: 0,
        snapshot: oversizedString,
      }),
    ).toThrow(TerminalDeliveryStateTooLargeError);
    expect(
      preaccountSemanticTerminalUpdateBytes({
        frame: "seed",
        revision: 0,
        snapshot: oversizedString,
      }),
    ).toMatchObject({ exact: true, bytes: expect.any(Number) });
  });

  it("keeps cooperative compact JSON syntax exact with the synchronous decoder", async () => {
    const snapshot = blankTerminalReplicaSnapshot(2, 1);
    const bytes = encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
    const text = new TextDecoder().decode(bytes);
    const expectedHash = hashTerminalReplicaSnapshot(snapshot);
    const candidates = [
      new TextEncoder().encode(`\u00a0${text}`),
      new TextEncoder().encode(text.replace("{", '{"__proto__":{"polluted":true},')),
    ];
    for (const candidate of candidates) {
      expect(() => decodeCompactSemanticTerminalUpdate(candidate)).toThrow();
      await expect(
        decodeVerifiedCompactSemanticTerminalUpdateCooperatively(candidate, null, expectedHash, {
          yieldControl: async () => Promise.resolve(),
        }),
      ).rejects.toThrow();
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects malformed UTF-8 identically below and above the cooperative threshold", async () => {
    const marker = "INVALID-UTF8-MARKER";
    const blank = blankTerminalReplicaSnapshot(2, 1);
    const markedRow = {
      ...blank.grid[0]!,
      cells: [{ ...blank.grid[0]!.cells[0]!, grapheme: marker }, blank.grid[0]!.cells[1]!],
    };
    const marked = { ...blank, grid: [markedRow] };
    const large = { ...marked, history: Array.from({ length: 4_000 }, () => markedRow) };
    const corruptMarker = (bytes: Uint8Array): Uint8Array => {
      const markerBytes = new TextEncoder().encode(marker);
      const offset = bytes.findIndex((byte, index) =>
        markerBytes.every((expected, markerIndex) => bytes[index + markerIndex] === expected),
      );
      if (offset < 0) throw new Error("UTF-8 marker missing from representation");
      const corrupted = bytes.slice();
      corrupted[offset] = 0xff;
      return corrupted;
    };
    const smallBytes = corruptMarker(
      encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot: marked }),
    );
    const largeBytes = corruptMarker(
      encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot: large }),
    );
    expect(smallBytes.byteLength).toBeLessThan(64 * 1_024);
    expect(largeBytes.byteLength).toBeGreaterThan(64 * 1_024);
    for (const [bytes, snapshot] of [
      [smallBytes, marked],
      [largeBytes, large],
    ] as const) {
      expect(() => decodeCompactSemanticTerminalUpdate(bytes)).toThrow();
      await expect(
        decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
          bytes,
          null,
          hashTerminalReplicaSnapshot(snapshot),
          { yieldControl: async () => Promise.resolve() },
        ),
      ).rejects.toThrow();
    }
    const legacyBytes = corruptMarker(
      encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot: marked }),
    );
    expect(() => decodeSemanticTerminalUpdate(legacyBytes)).toThrow();
  });

  it("preaccounts canonical legacy JSON bytes exactly and saturates without visiting the tail", () => {
    const blank = blankTerminalReplicaSnapshot(2, 1);
    for (const grapheme of [
      'quote"slash\\',
      "control\b\f\n\r\t\u0000",
      "\ud800",
      "\udc00",
      "😀",
      "界e\u0301",
    ]) {
      const snapshot = {
        ...blank,
        grid: [
          {
            ...blank.grid[0]!,
            cells: [{ ...blank.grid[0]!.cells[0]!, grapheme }, blank.grid[0]!.cells[1]!],
          },
        ],
      };
      const payload = { frame: "seed" as const, revision: 0, snapshot };
      const encoded = encodeSemanticTerminalUpdate(payload);
      expect(preaccountSemanticTerminalUpdateBytes(payload)).toEqual({
        exact: true,
        bytes: encoded.byteLength,
      });
      expect(preaccountSemanticTerminalUpdateBytes(payload, encoded.byteLength)).toEqual({
        exact: true,
        bytes: encoded.byteLength,
      });
      expect(preaccountSemanticTerminalUpdateBytes(payload, encoded.byteLength - 1)).toEqual({
        exact: false,
        atLeastBytes: encoded.byteLength,
      });
    }

    let tailVisited = false;
    const input = Object.defineProperty({ frame: "seed", revision: 0 }, "zzTail", {
      enumerable: true,
      get() {
        tailVisited = true;
        throw new Error("saturated traversal reached tail");
      },
    });
    expect(preaccountSemanticTerminalUpdateBytes(input as never, 1)).toEqual({
      exact: false,
      atLeastBytes: 2,
    });
    expect(tailVisited).toBe(false);
  });

  it("counts a compact-ineligible 170k-placement legacy seed exactly below the wire cap", () => {
    const blank = blankTerminalReplicaSnapshot(1, 1);
    const placement = {
      id: "i",
      kind: "k",
      row: 0,
      column: 0,
      columns: 1,
      rows: 1,
      contentDigest: "d",
    };
    const payload = {
      frame: "seed" as const,
      revision: 0,
      snapshot: { ...blank, placements: Array.from({ length: 170_000 }, () => placement) },
    };
    const counted = preaccountSemanticTerminalUpdateBytes(payload);
    expect(counted).toMatchObject({ exact: true });
    const encoded = encodeSemanticTerminalUpdate(payload);
    expect(counted).toEqual({ exact: true, bytes: encoded.byteLength });
    expect(encoded.byteLength).toBeLessThan(16 * 1024 * 1024);
    expect(() => encodeCompactSemanticTerminalUpdate(payload)).toThrow(
      TerminalDeliveryStateTooLargeError,
    );
  }, 30_000);

  it("ACKs only after exact chunks decode, apply and canonical hash verification", () => {
    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("negotiation failed");
    const { envelope, bytes } = seedEnvelope();
    let state = admitTerminalDeliveryEnvelope(
      createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a"),
      envelope,
    );
    if (!state.inFlight) throw new Error("not admitted");
    const assembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(tx, bytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      assembler.write(chunk);
    }
    const committed = commitTerminalDelivery(state, completeTerminalDelivery(state, assembler));
    expect(committed.ack.canonicalRevision).toBe(0);
    expect(committed.state.canonicalSnapshot).not.toBeNull();
    expect(committed.semanticUpdate).toMatchObject({ frame: "seed", revision: 0 });
  });

  it("rejects representation corruption and semantic frame confusion", () => {
    const { envelope, bytes } = seedEnvelope();
    const corrupt = new TerminalDeliveryAssembler(envelope);
    const chunks = splitTerminalDeliveryChunks(tx, bytes);
    chunks[0]!.bytes[0] = (chunks[0]!.bytes[0] ?? 0) ^ 1;
    for (const chunk of chunks) corrupt.write(chunk);
    expect(() => corrupt.complete()).toThrow(/hash mismatch/u);
    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("negotiation failed");
    let state = admitTerminalDeliveryEnvelope(
      createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a"),
      envelope,
    );
    if (!state.inFlight) throw new Error("not admitted");
    const seedAssembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(tx, bytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      seedAssembler.write(chunk);
    }
    state = commitTerminalDelivery(state, completeTerminalDelivery(state, seedAssembler)).state;
    const snapshot = blankTerminalReplicaSnapshot(2, 1);
    const patchBytes = encodeSemanticTerminalUpdate({
      frame: "seed",
      revision: 1,
      snapshot,
    });
    const confused = TerminalDeliveryEnvelopeSchemaZ.parse({
      ...envelope,
      transactionId: "00000000-0000-4000-8000-000000000004",
      frame: "patch",
      baseRevision: 0,
      canonicalRevision: 1,
      representationHash: hashTerminalDeliveryRepresentation(patchBytes),
      representationBytes: patchBytes.byteLength,
    });
    state = admitTerminalDeliveryEnvelope(state, confused);
    if (!state.inFlight) throw new Error("confused delivery not admitted");
    const assembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(confused.transactionId, patchBytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      assembler.write(chunk);
    }
    const staged = completeTerminalDelivery(state, assembler);
    expect(() => commitTerminalDelivery(state, staged)).toThrow(/frame or revision/u);
  });

  it("bounds allocation at the schema boundary and requires ANSI presentation before ACK", () => {
    const { envelope } = seedEnvelope();
    expect(
      () =>
        new TerminalDeliveryAssembler({
          ...envelope,
          representationBytes: Number.NaN,
        } as TerminalDeliveryEnvelope),
    ).toThrow();
    const bytes = new TextEncoder().encode("\u001b[2J");
    const ansiEnvelope = TerminalDeliveryEnvelopeSchemaZ.parse({
      ...envelope,
      encoding: "ansi-diff-v1",
      canonicalEquivalent: false,
      history: "complete",
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.byteLength,
    });
    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["ansi-diff-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("negotiation failed");
    let state = admitTerminalDeliveryEnvelope(
      createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a"),
      ansiEnvelope,
    );
    if (!state.inFlight) throw new Error("not admitted");
    const assembler = new TerminalDeliveryAssembler(state.inFlight);
    for (const chunk of splitTerminalDeliveryChunks(tx, bytes)) {
      state = admitTerminalDeliveryChunk(state, chunk);
      assembler.write(chunk);
    }
    const staged = completeTerminalDelivery(state, assembler);
    expect(() => commitTerminalDelivery(state, staged)).toThrow(/presentation/u);
    expect(
      commitTerminalDelivery(state, staged, { presentationApplied: true }).ack.canonicalRevision,
    ).toBe(0);
  });

  it("never advances a baseline on NACK", () => {
    const negotiated = negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      generation,
      nonce,
    );
    if (!negotiated.accepted) throw new Error("negotiation failed");
    const initial = createTerminalDeliveryClientState(negotiated.negotiated, "workspace", "pane-a");
    const rejected = nackTerminalDelivery(initial, {
      type: "terminal.delivery.nack",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      deliveryNonce: nonce,
      transactionId: null,
      reason: "gap",
      appliedRevision: -1,
    });
    expect(rejected.appliedRevision).toBe(-1);
    expect(rejected.reseedRequired).toBe(true);
  });
});
