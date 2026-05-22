/**
 * `createScriptTerminalId` determinism tests (G20-P1).
 *
 * The whole point of the script-derived id is determinism — two
 * callers asking for "the run script for project X, scope Y, script
 * Z" must collapse to one bridge. These tests pin that contract.
 */

import { describe, expect, it } from "vitest";
import { createScriptTerminalId } from "../terminals";

describe("createScriptTerminalId", () => {
  it("is deterministic for the same input", async () => {
    const a = await createScriptTerminalId({
      projectId: "proj",
      scopeId: "feat-x",
      kind: "run",
      script: "pnpm dev",
    });
    const b = await createScriptTerminalId({
      projectId: "proj",
      scopeId: "feat-x",
      kind: "run",
      script: "pnpm dev",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("changes when scopeId changes (same project + script)", async () => {
    const a = await createScriptTerminalId({
      projectId: "proj",
      scopeId: "feat-x",
      kind: "run",
      script: "pnpm dev",
    });
    const b = await createScriptTerminalId({
      projectId: "proj",
      scopeId: "feat-y",
      kind: "run",
      script: "pnpm dev",
    });
    expect(a).not.toBe(b);
  });

  it("changes when kind changes", async () => {
    const run = await createScriptTerminalId({
      projectId: "proj",
      scopeId: "feat-x",
      kind: "run",
      script: "pnpm dev",
    });
    const setup = await createScriptTerminalId({
      projectId: "proj",
      scopeId: "feat-x",
      kind: "setup",
      script: "pnpm dev",
    });
    expect(run).not.toBe(setup);
  });

  it("accepts taskId as a backward-compat alias for scopeId", async () => {
    const viaScope = await createScriptTerminalId({
      projectId: "proj",
      scopeId: "feat-x",
      kind: "run",
      script: "pnpm dev",
    });
    const viaTask = await createScriptTerminalId({
      projectId: "proj",
      taskId: "feat-x",
      kind: "run",
      script: "pnpm dev",
    });
    expect(viaScope).toBe(viaTask);
  });

  it("rejects calls without scope or task", async () => {
    await expect(
      createScriptTerminalId({
        projectId: "proj",
        kind: "run",
        script: "pnpm dev",
      }),
    ).rejects.toThrow(/scopeId/);
  });
});
