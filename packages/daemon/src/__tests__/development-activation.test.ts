import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveDevelopmentInstancePaths } from "../lib/development-instance.ts";
import {
  readDevelopmentActivation,
  writeDevelopmentRecord,
  developmentFailureResult,
  DevelopmentOperationError,
  type DevelopmentActivationReceipt,
} from "../lib/development-state.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dev-activation-"));
  roots.push(root);
  const instance = resolveDevelopmentInstancePaths({ worktree: root, store: join(root, "store") });
  mkdirSync(instance.root, { recursive: true, mode: 0o700 });
  return instance;
}
const receipt: DevelopmentActivationReceipt = {
  version: 1,
  operationId: "11111111-1111-4111-8111-111111111111",
  phase: "failed",
  target: {
    generation: "build-11111111-1111-4111-8111-111111111111",
    manifestHash: "a".repeat(64),
  },
  previous: {
    generation: "build-22222222-2222-4222-8222-222222222222",
    manifestHash: "b".repeat(64),
  },
  previousRuntime: { pid: 42, instanceId: "33333333-3333-4333-8333-333333333333" },
  readyRuntime: null,
  tmux: { pid: 43, generation: "build-22222222-2222-4222-8222-222222222222" },
  failurePhase: "starting",
};
it("exports exact prior/target pins and phase without arbitrary private fields", () => {
  const instance = fixture();
  writeDevelopmentRecord(join(instance.root, "activation.json"), {
    ...receipt,
    authToken: "secret",
    message: "Bearer secret",
  });
  expect(readDevelopmentActivation(instance)).toEqual(receipt);
  expect(
    developmentFailureResult(
      "restart",
      new DevelopmentOperationError(
        "activation-failed",
        "private secret",
        join(instance.root, "activation.json"),
      ),
      instance,
    ),
  ).toMatchObject({
    operation: "restart",
    reason: "activation-failed",
    receipt: join(instance.root, "activation.json"),
  });
});
it("rejects incomplete or malformed recovery pins and phases", () => {
  const instance = fixture();
  for (const value of [
    { ...receipt, previous: { generation: "../other", manifestHash: "b".repeat(64) } },
    { ...receipt, phase: "Bearer secret" },
    { ...receipt, previousRuntime: { pid: -1, instanceId: "secret" } },
  ]) {
    writeDevelopmentRecord(join(instance.root, "activation.json"), value);
    expect(() => readDevelopmentActivation(instance)).toThrow("Invalid activation");
  }
});
