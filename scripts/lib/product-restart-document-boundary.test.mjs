import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { observeRestartDocumentBoundary } from "./product-restart-document-boundary.mjs";

test("restart baseline survives renderer navigation and removes its listener", () => {
  const page = new EventEmitter();
  const main = {};
  page.mainFrame = () => main;
  const boundary = observeRestartDocumentBoundary(page);
  const observation = {
    runtimeReplacement: { documentEpoch: 123, acceptedCount: 4, socketEventCount: 2 },
    workspaceEvidence: {
      phase: "live",
      target: { daemon: { instanceId: "g1" } },
      authority: { generation: "g1" },
    },
  };
  assert.throws(() => boundary.capture(observation, "other"));
  boundary.capture(observation, "g1");
  page.emit("framenavigated", {});
  assert.equal(boundary.evidence(observation).navigationCount, 0);
  page.emit("framenavigated", main);
  assert.equal(boundary.evidence(observation).navigationCount, 1);
  assert.equal(boundary.evidence(observation).before.epoch, 123);
  assert.throws(() => boundary.capture(observation, "g1"));
  for (let i = 0; i < 20; i++) page.emit("framenavigated", main);
  assert.equal(boundary.evidence(observation).navigationCount, 9);
  boundary.dispose();
  boundary.dispose();
  assert.equal(page.listenerCount("framenavigated"), 0);
});
