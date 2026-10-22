import assert from "node:assert/strict";
import { test } from "node:test";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createSnapshotSerializer, decodeSurfacePublication } from "./snapshot-wire.ts";

for (const encoding of ["legacy", "rle-v1"] as const) {
  test(`${encoding} helper surface preserves terminal content and rejects mixed encoding`, () => {
    const source = blankTerminalReplicaSnapshot(80, 24);
    const serialize = createSnapshotSerializer(encoding);
    const encoded = serialize(source);
    assert.equal(serialize(source), encoded);
    assert.equal(serialize(null), "null");
    const wire = [{ paneId: "%1", snapshot: JSON.parse(encoded) }];
    assert.deepEqual(decodeSurfacePublication(wire, encoding), [
      { paneId: "%1", snapshot: source },
    ]);
    assert.throws(() =>
      decodeSurfacePublication(wire, encoding === "legacy" ? "rle-v1" : "legacy"),
    );
    assert.throws(() =>
      decodeSurfacePublication([...wire, { ...wire[0], injected: true }], encoding),
    );
    assert.throws(() => decodeSurfacePublication(Array(25).fill(wire[0]), encoding));
  });
}
