import type { InteractionReceipt, SessionRuntimeSemanticIntent } from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  SessionRuntimeIntentError,
  SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY,
  SessionSemanticMutationExecutor,
  type ExecutableSessionRuntimeIntent,
  type SessionRuntimeReceiptInput,
} from "./semantic-mutation-executor.ts";

const OP_A = "11111111-1111-4111-8111-111111111111";
const OP_B = "22222222-2222-4222-8222-222222222222";

function operationId(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}

function send(workspaceName = "alpha", semanticPaneId = "pane.alpha") {
  return {
    verb: "workspace.pane.send",
    workspaceName,
    semanticPaneId,
    text: "hello",
    submit: true,
    origin: "sdk",
  } satisfies SessionRuntimeSemanticIntent;
}

function rig(
  options: {
    execute?: (operationId: string, intent: ExecutableSessionRuntimeIntent) => Promise<void>;
    timeout?: number;
  } = {},
) {
  let sequence = 0;
  const receipts: InteractionReceipt[] = [];
  const publishReceipt = (input: SessionRuntimeReceiptInput): InteractionReceipt => {
    const receipt = { type: "interaction.receipt", sequence: ++sequence, ...input } as const;
    receipts.push(receipt);
    return receipt;
  };
  const executor = new SessionSemanticMutationExecutor({
    resolveSession: (workspace) => (workspace === "beta" ? "session-beta" : "session-alpha"),
    execute: options.execute ?? (async () => undefined),
    publishReceipt,
    observationTimeoutMs: options.timeout ?? 100,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  return { executor, receipts };
}

describe("SessionSemanticMutationExecutor", () => {
  it("keeps one strict FIFO through tmux observation for each session", async () => {
    const started: string[] = [];
    const { executor, receipts } = rig({
      execute: async (operationId) => {
        started.push(operationId);
      },
    });
    const first = executor.submit(OP_A, send());
    const second = executor.submit(OP_B, send("alpha", "pane.beta"));

    await vi.waitFor(() => expect(started).toEqual([OP_A]));
    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await first;
    await vi.waitFor(() => expect(started).toEqual([OP_A, OP_B]));
    executor.observe({
      operationId: OP_B,
      workspaceName: "alpha",
      semanticPaneId: "pane.beta",
      operationKind: "workspace.pane.send",
    });
    await second;

    expect(receipts.map(({ operationId, phase }) => [operationId, phase])).toEqual([
      [OP_A, "accepted"],
      [OP_B, "accepted"],
      [OP_A, "observed"],
      [OP_B, "observed"],
    ]);
    await executor.dispose();
  });

  it("allows different tmux sessions to progress independently", async () => {
    const started: string[] = [];
    const { executor } = rig({
      execute: async (operationId) => {
        started.push(operationId);
      },
    });
    const alpha = executor.submit(OP_A, send("alpha", "pane.alpha"));
    const beta = executor.submit(OP_B, send("beta", "pane.beta"));
    await vi.waitFor(() => expect(new Set(started)).toEqual(new Set([OP_A, OP_B])));

    executor.observe({
      operationId: OP_B,
      workspaceName: "beta",
      semanticPaneId: "pane.beta",
      operationKind: "workspace.pane.send",
    });
    await beta;
    let alphaSettled = false;
    void alpha.finally(() => {
      alphaSettled = true;
    });
    await Promise.resolve();
    expect(alphaSettled).toBe(false);
    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await alpha;
    await executor.dispose();
  });

  it("does not await slow or disconnected receipt consumers", async () => {
    const { executor } = rig();
    const never = new Promise<void>(() => undefined);
    const slow = vi.fn(async () => await never);
    const disconnected = vi.fn();
    executor.onReceipt(slow);
    const disconnect = executor.onReceipt(disconnected);
    disconnect();

    const submitted = executor.submit(OP_A, send());
    await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await submitted;
    expect(disconnected).not.toHaveBeenCalled();
    await executor.dispose();
  });

  it("reuses one receipt lifecycle and dispatch for a same-fingerprint retry", async () => {
    const execute = vi.fn(async () => undefined);
    const { executor, receipts } = rig({ execute });
    const first = executor.submit(OP_A, send());
    const retry = executor.submit(OP_A, send());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await Promise.all([first, retry]);
    await executor.submit(OP_A, send());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipts.map((receipt) => receipt.phase)).toEqual(["accepted", "observed"]);
    await executor.dispose();
  });

  it("rejects conflicting operation ids and unsupported verbs at the request boundary", async () => {
    const execute = vi.fn(async () => undefined);
    const { executor, receipts } = rig({ execute });
    const first = executor.submit(OP_A, send());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    await expect(
      executor.submit(OP_A, { ...send(), semanticPaneId: "pane.other" }),
    ).rejects.toMatchObject({ outcome: "rejected" });
    await expect(
      executor.submit(OP_B, {
        verb: "workspace.window.split",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        direction: "right",
      }),
    ).rejects.toMatchObject({ outcome: "rejected" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipts.map((receipt) => receipt.phase)).toEqual(["accepted"]);

    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await first;
    expect(receipts.map((receipt) => receipt.phase)).toEqual(["accepted", "observed"]);
    await executor.dispose();
  });

  it("accepts operation 257 by retiring the oldest settled replay record", async () => {
    let executor!: SessionSemanticMutationExecutor;
    const execute = vi.fn(async (id: string, intent: ExecutableSessionRuntimeIntent) => {
      queueMicrotask(() => {
        executor.observe({
          operationId: id,
          workspaceName: intent.workspaceName,
          semanticPaneId: intent.semanticPaneId,
          operationKind: intent.verb,
        });
      });
    });
    const built = rig({ execute });
    executor = built.executor;

    for (let index = 1; index <= SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY + 1; index += 1) {
      await executor.submit(operationId(index), send());
    }

    expect(execute).toHaveBeenCalledTimes(SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY + 1);
    expect(built.receipts).toHaveLength((SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY + 1) * 2);
    await executor.dispose();
  });

  it("never evicts pending records and backpressures only when every slot is active", async () => {
    const execute = vi.fn(async () => undefined);
    const { executor, receipts } = rig({ execute });
    const pending = Array.from({ length: SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY }, (_, index) =>
      executor.submit(operationId(index + 1), send()),
    );
    const firstRetry = executor.submit(operationId(1), send());
    expect(firstRetry).toBe(pending[0]);

    await expect(
      executor.submit(operationId(SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY + 1), send()),
    ).rejects.toMatchObject({ outcome: "rejected" });
    expect(receipts).toHaveLength(SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY);

    const outcomes = Promise.allSettled(pending);
    await executor.dispose();
    expect((await outcomes).every((outcome) => outcome.status === "rejected")).toBe(true);
  });

  it("publishes rejected when authority refuses and timed-out without tmux truth", async () => {
    const rejected = rig({ execute: async () => Promise.reject(new Error("no pane")) });
    await expect(rejected.executor.submit(OP_A, send())).rejects.toMatchObject({
      outcome: "rejected",
    });
    expect(rejected.receipts.map((receipt) => receipt.phase)).toEqual(["accepted", "rejected"]);
    await rejected.executor.dispose();

    const timedOut = rig({ timeout: 5 });
    await expect(timedOut.executor.submit(OP_B, send())).rejects.toMatchObject({
      outcome: "timed-out",
    });
    expect(timedOut.receipts.map((receipt) => receipt.phase)).toEqual(["accepted", "timed-out"]);
    await timedOut.executor.dispose();
  });

  it("settles in-flight and queued work deterministically on shutdown", async () => {
    const started: string[] = [];
    const { executor, receipts } = rig({
      execute: async (operationId) => {
        started.push(operationId);
      },
    });
    const first = executor.submit(OP_A, send());
    const second = executor.submit(OP_B, send("alpha", "pane.beta"));
    await vi.waitFor(() => expect(started).toEqual([OP_A]));

    const disposed = executor.dispose();
    await expect(first).rejects.toBeInstanceOf(SessionRuntimeIntentError);
    await expect(second).rejects.toBeInstanceOf(SessionRuntimeIntentError);
    await disposed;
    expect(receipts.map(({ operationId, phase }) => [operationId, phase])).toEqual([
      [OP_A, "accepted"],
      [OP_B, "accepted"],
      [OP_A, "rejected"],
      [OP_B, "rejected"],
    ]);
  });
});
