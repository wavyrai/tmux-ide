import assert from "node:assert/strict";
import { test } from "node:test";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { preparePublication, renderPreparedPublication } from "./prepared-publication.ts";
import { serializeBrowserPublication } from "./browser-publication.ts";

test("deferred publication freezes control metadata and keeps the complete immutable frame", () => {
  const snapshot = blankTerminalReplicaSnapshot(2, 1);
  const prefix = { version: 1, selectedPane: "%1", sessions: ["s1"] };
  const suffix = {
    selectionIdentity: "a",
    snapshot,
    machines: { phase: "ready" },
    omitted: undefined,
  };
  const expected = serializeBrowserPublication(prefix, suffix, null);
  const prepared = preparePublication(prefix, suffix, null);
  prefix.sessions.push("later");
  suffix.machines.phase = "failed";
  assert.equal(renderPreparedPublication(prepared, JSON.stringify(snapshot)), expected);
  assert.equal(prepared.snapshot, snapshot);
});

test("deferred null frame preserves exact legacy envelope order and escaping", () => {
  const prefix = { version: 1, selectedPane: null, request: 2 };
  const suffix = { selectionIdentity: null, snapshot: null, machines: '"\\😀' };
  assert.equal(
    renderPreparedPublication(preparePublication(prefix, suffix, null), "null"),
    serializeBrowserPublication(prefix, suffix, null),
  );
});
