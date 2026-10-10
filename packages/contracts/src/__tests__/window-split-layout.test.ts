import { expect, it } from "vitest";
import {
  WindowSplitLayoutResourceSchemaZ as layout,
  WindowSplitResizeTargetSchemaZ as target,
} from "../window-split-layout.ts";
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const window = {
  liveSessionId: `live-session.${"a".repeat(20)}`,
  linkId: `window-link.${"a".repeat(32)}`,
  expectedSemanticWindowId: "window.one",
  linkRevision: 1,
};
const fixture = () => ({
  version: 1,
  window,
  layoutId: uuid,
  cols: 80,
  rows: 24,
  panes: [
    { semanticPaneId: "pane.one", left: 0, top: 0, width: 39, height: 24 },
    { semanticPaneId: "pane.two", left: 40, top: 0, width: 40, height: 24 },
  ],
  splits: [{ splitId: uuid, axis: "cols", boundary: 39, start: 0, length: 24 }],
});
it("accepts bounded semantic layouts and endpoint requests without exposing native authority", () => {
  expect(layout.parse(fixture())).toEqual(fixture());
  for (const boundary of [0, 4096])
    expect(target.parse({ window, layoutId: uuid, splitId: uuid, boundary }).boundary).toBe(
      boundary,
    );
});
it("rejects duplicate pane/split identities and rectangles outside the root", () => {
  const a = fixture();
  a.panes[1]!.semanticPaneId = a.panes[0]!.semanticPaneId;
  expect(layout.safeParse(a).success).toBe(false);
  const b = fixture();
  b.splits.push({ ...b.splits[0]! });
  expect(layout.safeParse(b).success).toBe(false);
  for (const field of ["width", "height"] as const) {
    const c = fixture();
    c.panes[1]![field] = 4096;
    expect(layout.safeParse(c).success).toBe(false);
  }
});
it("validates axis-specific interior boundaries and cross-axis spans", () => {
  for (const axis of ["cols", "rows"]) {
    const limit = axis === "cols" ? 80 : 24,
      cross = axis === "cols" ? 24 : 80;
    const valid = {
      ...fixture(),
      splits: [{ splitId: uuid, axis, boundary: limit - 1, start: cross - 1, length: 1 }],
    };
    expect(layout.safeParse(valid).success).toBe(true);
    for (const boundary of [0, limit])
      expect(
        layout.safeParse({ ...valid, splits: [{ ...valid.splits[0]!, boundary }] }).success,
      ).toBe(false);
    expect(
      layout.safeParse({ ...valid, splits: [{ ...valid.splits[0]!, length: 2 }] }).success,
    ).toBe(false);
  }
});
it("rejects unknown raw fields at every authority boundary", () => {
  const value = fixture();
  for (const raw of [
    { ...value, nativeLayout: "tree" },
    { ...value, window: { ...window, nativeWindowId: "@1" } },
    { ...value, panes: [{ ...value.panes[0]!, nativePaneId: "%1" }] },
    { ...value, splits: [{ ...value.splits[0]!, path: [0, 1] }] },
  ])
    expect(layout.safeParse(raw).success).toBe(false);
  expect(
    target.safeParse({ window, layoutId: uuid, splitId: uuid, boundary: 5, nativePath: [0] })
      .success,
  ).toBe(false);
});
it("enforces bounded collections, UUID handles and integral geometry", () => {
  const v = fixture();
  expect(layout.safeParse({ ...v, panes: [] }).success).toBe(false);
  expect(
    layout.safeParse({
      ...v,
      panes: Array.from({ length: 257 }, (_, i) => ({
        ...v.panes[0]!,
        semanticPaneId: `pane.${i}`,
      })),
    }).success,
  ).toBe(false);
  expect(layout.safeParse({ ...v, splits: Array(256).fill(v.splits[0]) }).success).toBe(false);
  for (const cols of [0, 4097, 1.5]) expect(layout.safeParse({ ...v, cols }).success).toBe(false);
  for (const boundary of [-1, 4097, 0.5])
    expect(target.safeParse({ window, layoutId: uuid, splitId: uuid, boundary }).success).toBe(
      false,
    );
  expect(
    target.safeParse({ window, layoutId: "native-path", splitId: uuid, boundary: 1 }).success,
  ).toBe(false);
});

it("split resize mutation and receipt preserve request identity while allowing clamped observation", async () => {
  const { WorkspaceMultiplexerIntentSchemaZ, WorkspaceMultiplexerMutationResultSchemaZ } =
    await import("../workspace-multiplexer.ts");
  const { InteractionReceiptV1SchemaZ } = await import("../interaction-receipts.ts");
  const requestTarget = { window, layoutId: uuid, splitId: uuid, boundary: 79 };
  const intent = {
    verb: "workspace.window.split.resize",
    workspaceName: "project",
    target: requestTarget,
  };
  expect(WorkspaceMultiplexerIntentSchemaZ.parse(intent)).toEqual(intent);
  expect(WorkspaceMultiplexerIntentSchemaZ.safeParse({ ...intent, cells: 42 }).success).toBe(false);
  expect(
    WorkspaceMultiplexerIntentSchemaZ.safeParse({
      ...intent,
      target: { ...requestTarget, path: [0] },
    }).success,
  ).toBe(false);
  const result = {
    ...intent,
    operationId: uuid,
    daemonInstanceId: uuid,
    outcome: "applied",
    axis: "cols",
    boundary: 70,
  };
  expect(WorkspaceMultiplexerMutationResultSchemaZ.parse(result)).toEqual(result);
  expect(
    WorkspaceMultiplexerMutationResultSchemaZ.safeParse({ ...result, nativeWindowId: "@1" })
      .success,
  ).toBe(false);
  const receipt = {
    type: "interaction.receipt",
    sequence: 1,
    operationId: uuid,
    origin: "gui",
    workspaceName: "project",
    sourceSemanticPaneId: null,
    target: { kind: "window-link", target: window },
    operationKind: intent.verb,
    phase: "observed",
    summary: { operationKind: intent.verb, layoutId: uuid, splitId: uuid, boundary: 79 },
    proof: {
      operationKind: intent.verb,
      outcome: "applied",
      target: requestTarget,
      axis: "cols",
      boundary: 70,
    },
    at: "2026-10-10T12:00:00.000Z",
    resourceRevision: 1,
  };
  expect(InteractionReceiptV1SchemaZ.safeParse(receipt).success).toBe(true);
  for (const change of [
    { layoutId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { splitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { boundary: 78 },
    { window: { ...window, linkRevision: 2 } },
  ])
    expect(
      InteractionReceiptV1SchemaZ.safeParse({
        ...receipt,
        proof: { ...receipt.proof, target: { ...requestTarget, ...change } },
      }).success,
    ).toBe(false);
  expect(
    InteractionReceiptV1SchemaZ.safeParse({
      ...receipt,
      target: { kind: "pane", semanticPaneId: "pane.one" },
    }).success,
  ).toBe(false);
  expect(
    InteractionReceiptV1SchemaZ.safeParse({
      ...receipt,
      summary: { ...receipt.summary, nativePath: [0] },
    }).success,
  ).toBe(false);
});
