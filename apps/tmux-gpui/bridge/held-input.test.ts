import { test } from "node:test";
import assert from "node:assert/strict";
import { runHostedLiveCommands } from "./hosted-live-commands.ts";
import type { HostedLiveCommandContext } from "./hosted-live-command-context.ts";
import { createInputPipeline } from "./input-pipeline.ts";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { z } from "zod";
const token = "a".repeat(64);
function harness(input: unknown, fenced = true) {
  let current = token,
    rejected = 0;
  const sent: unknown[][] = [];
  const pipeline = createInputPipeline((error) => {
    throw error;
  });
  const context = {
    commands: (async function* () {
      yield fenced ? { kind: "fenced-input", id: "pane", inputTarget: token, input } : input;
    })(),
    stopped: false,
    stop: () => {
      context.stopped = true;
    },
    foreground: true,
    inputPipeline: pipeline,
    selected: "pane",
    selectPaneSchema: z.object({ kind: z.literal("select-pane"), id: z.string() }).strict(),
    currentInputTarget: () => current,
    currentInputProof: () => ({ generation: "generation", incarnation: "incarnation" }),
    rejectInputTarget: () => {
      rejected++;
    },
    restorePending: false,
    historyRestoration: { publication: () => ({ state: "live" }) },
    viewport: { offset: 0 },
    latest: { snapshot: blankTerminalReplicaSnapshot(4, 2) },
    lifetimes: new Map([["pane", "lifetime"]]),
    config: { workspaceName: "workspace" },
    inputRuntime: {
      ownsConnectionAuthority: () => true,
      sendTerminalInput: async (...args: unknown[]) => {
        sent.push(args);
        return "ok";
      },
    },
  } as unknown as HostedLiveCommandContext;
  return {
    context,
    pipeline,
    sent,
    replace: () => {
      current = "b".repeat(64);
    },
    rejected: () => rejected,
  };
}
test("held input retains proof into daemon send; ordinary input remains unfenced", async () => {
  for (const fenced of [true, false]) {
    const h = harness({ kind: "text", data: "abc" }, fenced);
    await runHostedLiveCommands(h.context);
    await h.pipeline.barrier();
    assert.equal(h.sent.length, 1);
    assert.deepEqual(
      h.sent[0][4],
      fenced ? { generation: "generation", incarnation: "incarnation" } : undefined,
    );
  }
});
test("held command already stale at dequeue is dropped with one interruption", async () => {
  const h = harness({ kind: "text", data: "abc" });
  h.replace();
  await runHostedLiveCommands(h.context);
  assert.equal(h.sent.length, 0);
  assert.equal(h.rejected(), 1);
});
test("held target is rechecked after actual eight-operation pipeline capacity wait", async () => {
  const h = harness({ kind: "text", data: "abc" });
  const releases: (() => void)[] = [];
  for (let i = 0; i < 8; i++)
    await h.pipeline.submit(() => new Promise<void>((resolve) => releases.push(resolve)));
  const running = runHostedLiveCommands(h.context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.replace();
  releases[0]();
  await running;
  for (const release of releases) release();
  await h.pipeline.barrier();
  assert.equal(h.sent.length, 0);
  assert.equal(h.rejected(), 1);
});
test("paste lifetime is rechecked for every chunk and never resumes after rejection", async () => {
  const h = harness({ kind: "paste", data: "a".repeat(65536) });
  const original = h.context.inputRuntime.sendTerminalInput;
  h.context.inputRuntime.sendTerminalInput = async (...args) => {
    const result = await original(...args);
    h.replace();
    return result;
  };
  await runHostedLiveCommands(h.context);
  await h.pipeline.barrier();
  assert.equal(h.sent.length, 1);
  assert.equal(h.rejected(), 1);
  assert.deepEqual(h.sent[0][4], { generation: "generation", incarnation: "incarnation" });
});

test("held rejection stops helper before later ordinary suffix can dispatch", async () => {
  const h = harness({ kind: "text", data: "prefix" });
  h.context.commands = (async function* () {
    yield {
      kind: "fenced-input",
      id: "pane",
      inputTarget: token,
      input: { kind: "text", data: "prefix" },
    };
    yield { kind: "text", data: "suffix" };
  })();
  h.replace();
  await runHostedLiveCommands(h.context);
  assert.equal(h.context.stopped, true);
  assert.equal(h.sent.length, 0);
  assert.equal(h.rejected(), 1);
});

test("daemon held lifetime refusal signals interruption and stops suffix", async () => {
  const h = harness({ kind: "paste", data: "prefix" });
  h.context.inputRuntime.sendTerminalInput = async () => {
    throw Error("daemon lifetime mismatch");
  };
  await assert.rejects(runHostedLiveCommands(h.context), /daemon lifetime mismatch/);
  assert.equal(h.context.stopped, true);
  assert.equal(h.rejected(), 1);
});
