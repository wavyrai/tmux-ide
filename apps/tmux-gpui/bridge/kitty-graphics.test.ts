import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import type { Layout } from "./topology.ts";
import {
  canvasPlacements,
  createKittyGraphicsReceiver,
  createKnownDigests,
  parseKnownDigests,
} from "./kitty-graphics.ts";

const digest = "a".repeat(32);
const PLACEHOLDER = String.fromCodePoint(0x10eeee);

function snapshotWithPlaceholder() {
  const snapshot = blankTerminalReplicaSnapshot(4, 2);
  const grid = snapshot.grid.map((row) => ({ ...row, cells: [...row.cells] }));
  grid[1]!.cells[1] = {
    grapheme: PLACEHOLDER + "̅̅",
    width: 1,
    foreground: { kind: "indexed", index: 3 },
    background: { kind: "default" },
    attributes: 0,
  };
  return { ...snapshot, grid };
}

const state = {
  revision: 1,
  images: [
    {
      imageId: 3,
      digest,
      format: "png" as const,
      width: 10,
      height: 10,
      bytes: 50,
      placeholder: { columns: 1, rows: 1 },
    },
  ],
  placements: [],
};

test("receiver resolves placements and pulls each missing digest once", () => {
  const requests: [string, string[]][] = [];
  const receiver = createKittyGraphicsReceiver({
    known: [],
    request: (pane, digests) => requests.push([pane, digests]),
    emit: () => {},
  });
  const snapshot = snapshotWithPlaceholder();
  assert.deepEqual(receiver.placements("p", snapshot), []);
  receiver.state("p", state);
  const placements = receiver.placements("p", snapshot);
  assert.deepEqual(
    placements.map(({ row, column, digest: d }) => [row, column, d]),
    [[1, 1, digest]],
  );
  receiver.placements("p", snapshot);
  assert.deepEqual(requests, [["p", [digest]]]);
  receiver.missing([digest]);
  receiver.placements("p", snapshot);
  assert.equal(requests.length, 2);
});

test("receiver does not request digests the window already holds", () => {
  const requests: string[][] = [];
  const receiver = createKittyGraphicsReceiver({
    known: parseKnownDigests(`${digest},not-a-digest`),
    request: (_pane, digests) => requests.push(digests),
    emit: () => {},
  });
  receiver.state("p", state);
  assert.equal(receiver.placements("p", snapshotWithPlaceholder()).length, 1);
  assert.deepEqual(requests, []);
});

test("canvas placements move to the pane content origin and drop overflow", () => {
  const layout: Layout = {
    type: "layout",
    semanticWindowId: "w",
    windowName: "w",
    currentWindow: true,
    cols: 9,
    rows: 4,
    zoomed: false,
    paneBorderStatus: "top",
    panes: [{ pane: "p", left: 5, top: 0, width: 4, height: 4, active: true }],
  };
  const placement = {
    digest,
    row: 1,
    column: 1,
    rows: 2,
    columns: 2,
    sourceRow: 0,
    sourceColumn: 0,
    totalRows: 2,
    totalColumns: 2,
    image: "p#3",
  };
  assert.deepEqual(
    canvasPlacements(layout, [
      { paneId: "p", placements: [placement, { ...placement, row: 2 }] },
      { paneId: "gone", placements: [placement] },
    ]),
    [{ ...placement, row: 2, column: 6 }],
  );
});

test("known digests are recorded on the last chunk and bounded", () => {
  const known = createKnownDigests(2);
  const chunk = (d: string, offset: number) => ({
    digest: d,
    format: "png" as const,
    width: 1,
    height: 1,
    total: 6,
    offset,
    data: Buffer.from("abc").toString("base64"),
  });
  known.observe(chunk(digest, 0));
  assert.equal(known.env(), "");
  known.observe(chunk(digest, 3));
  known.observe(chunk("b".repeat(32), 3));
  known.observe(chunk("c".repeat(32), 3));
  assert.deepEqual(known.env().split(","), ["b".repeat(32), "c".repeat(32)]);
  known.forget(["c".repeat(32)]);
  assert.equal(known.env(), "b".repeat(32));
});
