import type { InteractionReceipt, SessionRuntimeSemanticIntent } from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  SessionRuntimeIntentError,
  SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY,
  SessionSemanticMutationExecutor,
  type ExecutableSessionRuntimeIntent,
  type SessionRuntimeIntentResult,
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

function resultFor(
  operationId: string,
  intent: ExecutableSessionRuntimeIntent,
): SessionRuntimeIntentResult {
  if (intent.verb === "workspace.pane.read") return;
  const base = {
    operationId,
    daemonInstanceId: OP_A,
    workspaceName: intent.workspaceName,
    outcome: "applied" as const,
  };
  switch (intent.verb) {
    case "workspace.window.split":
      return {
        ...base,
        verb: intent.verb,
        direction: intent.direction,
        semanticPaneId: "pane.created",
        displayTitle: intent.displayTitle ?? "Terminal",
      };
    case "workspace.window.kill":
      return { ...base, verb: intent.verb, remainingWindowCount: 1 };
    case "workspace.pane.kill":
      return { ...base, verb: intent.verb, windowClosed: false, remainingWindowCount: 1 };
    case "workspace.session.kill":
      return { ...base, verb: intent.verb };
    case "workspace.rename":
      return { ...base, verb: intent.verb, scope: intent.scope, name: intent.name };
    case "workspace.pane.zoom.toggle":
      return { ...base, verb: intent.verb, semanticPaneId: intent.semanticPaneId, zoomed: true };
    case "workspace.pane.select":
      return { ...base, verb: intent.verb, semanticPaneId: intent.semanticPaneId };
    case "workspace.pane.send":
      return {
        ...base,
        verb: intent.verb,
        sourceSemanticPaneId: intent.sourceSemanticPaneId ?? null,
        semanticPaneId: intent.semanticPaneId,
        origin: intent.origin,
        characterCount: 5,
        byteCount: 5,
        submitted: intent.submit,
      };
    case "workspace.pane.swap":
      return {
        ...base,
        verb: intent.verb,
        sourceSemanticPaneId: intent.sourceSemanticPaneId,
        targetSemanticPaneId: intent.targetSemanticPaneId,
      };
    case "workspace.pane.resize":
      return {
        ...base,
        verb: intent.verb,
        semanticPaneId: intent.semanticPaneId,
        axis: intent.axis,
        cells: 72,
      };
  }
}

function rig(
  options: {
    execute?: (
      operationId: string,
      intent: ExecutableSessionRuntimeIntent,
    ) => SessionRuntimeIntentResult;
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
    execute: options.execute ?? resultFor,
    publishReceipt,
    observationTimeoutMs: options.timeout ?? 100,
    now: () => new Date("2026-08-11T10:00:00.000Z"),
  });
  return { executor, receipts };
}

function submit(
  executor: SessionSemanticMutationExecutor,
  operationId: string,
  intent: SessionRuntimeSemanticIntent,
  authenticatedSourceSemanticPaneId: string | null = null,
  authorizeBeforeEffect?: () => void,
  origin: "gui" | "tui" | "cli" | "sdk" = "sdk",
) {
  return executor.submit(operationId, intent, {
    origin,
    authenticatedSourceSemanticPaneId,
    authorizeBeforeEffect,
  });
}

describe("SessionSemanticMutationExecutor", () => {
  it("publishes result-derived accepted and observed receipts for all eleven intents", async () => {
    const intents: SessionRuntimeSemanticIntent[] = [
      {
        verb: "workspace.window.split",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        direction: "right",
      },
      {
        verb: "workspace.window.kill",
        workspaceName: "alpha",
        target: { by: "pane", semanticPaneId: "pane.alpha" },
      },
      { verb: "workspace.pane.kill", workspaceName: "alpha", semanticPaneId: "pane.alpha" },
      { verb: "workspace.session.kill", workspaceName: "alpha" },
      { verb: "workspace.rename", workspaceName: "alpha", scope: "session", name: "renamed" },
      {
        verb: "workspace.pane.zoom.toggle",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        desired: "toggle",
      },
      { verb: "workspace.pane.select", workspaceName: "alpha", semanticPaneId: "pane.alpha" },
      send(),
      {
        verb: "workspace.pane.swap",
        workspaceName: "alpha",
        sourceSemanticPaneId: "pane.alpha",
        targetSemanticPaneId: "pane.beta",
      },
      {
        verb: "workspace.pane.resize",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        axis: "cols",
        cells: 80,
      },
      {
        verb: "workspace.pane.read",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        origin: "sdk",
      },
    ];
    let executor!: SessionSemanticMutationExecutor;
    const built = rig({
      execute: (id, intent) => {
        if (intent.verb === "workspace.pane.send" || intent.verb === "workspace.pane.read") {
          queueMicrotask(() =>
            executor.observe({
              operationId: id,
              workspaceName: intent.workspaceName,
              semanticPaneId: intent.semanticPaneId,
              operationKind: intent.verb,
            }),
          );
        }
        return resultFor(id, intent);
      },
    });
    executor = built.executor;

    for (const [index, intent] of intents.entries()) {
      await submit(executor, operationId(index + 100), intent);
    }

    expect(built.receipts).toHaveLength(intents.length * 2);
    for (const [index, intent] of intents.entries()) {
      const [accepted, observed] = built.receipts.slice(index * 2, index * 2 + 2);
      expect(accepted).toMatchObject({
        operationKind: intent.verb,
        phase: "accepted",
        proof: null,
      });
      expect(observed).toMatchObject({ operationKind: intent.verb, phase: "observed" });
      expect(observed!.proof).toMatchObject({ operationKind: intent.verb });
      expect(observed!.target.kind).toMatch(/^(session|window|pane)$/u);
    }
    expect(
      built.receipts.find(
        (receipt) =>
          receipt.operationKind === "workspace.pane.resize" && receipt.phase === "observed",
      )?.proof,
    ).toMatchObject({ cells: 72 });
    await executor.dispose();
  });

  it("revalidates a queued structural mutation before the sole synchronous effect lane", async () => {
    const started: string[] = [];
    const { executor, receipts } = rig({
      execute: (id, intent) => {
        started.push(id);
        return resultFor(id, intent);
      },
    });
    let authorized = true;
    const first = submit(executor, OP_A, send());
    const resizeIntent = {
      verb: "workspace.pane.resize",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      axis: "cols",
      cells: 80,
    } as const;
    const queued = submit(executor, OP_B, resizeIntent, null, () => {
      if (!authorized) throw new Error("controller became stale");
    });
    await vi.waitFor(() => expect(started).toEqual([OP_A]));
    authorized = false;
    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await first;
    await expect(queued).rejects.toMatchObject({ outcome: "rejected" });
    expect(started).toEqual([OP_A]);
    expect(receipts.at(-1)).toMatchObject({
      operationKind: "workspace.pane.resize",
      phase: "rejected",
    });
    await executor.dispose();
  });

  it("revalidates queued authority immediately before effect and rejects stale work", async () => {
    const started: string[] = [];
    const { executor, receipts } = rig({
      execute: (operationId, intent) => {
        started.push(operationId);
        return resultFor(operationId, intent);
      },
    });
    let authorized = true;
    const first = submit(executor, OP_A, send());
    const queued = submit(executor, OP_B, send("alpha", "pane.beta"), "pane.source", () => {
      if (!authorized) throw new Error("principal became stale");
    });
    await vi.waitFor(() => expect(started).toEqual([OP_A]));
    authorized = false;
    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await first;
    await expect(queued).rejects.toMatchObject({ outcome: "rejected" });
    expect(started).toEqual([OP_A]);
    expect(receipts.map(({ operationId, phase }) => [operationId, phase])).toEqual([
      [OP_A, "accepted"],
      [OP_B, "accepted"],
      [OP_A, "observed"],
      [OP_B, "rejected"],
    ]);
    await executor.dispose();
  });

  it("keeps authorization callbacks outside idempotency fingerprints and replay replacement", async () => {
    const firstGuard = vi.fn();
    const replayGuard = vi.fn(() => {
      throw new Error("must not replace original submission guard");
    });
    const started: string[] = [];
    const { executor } = rig({
      execute: (operationId, intent) => {
        started.push(operationId);
        return resultFor(operationId, intent);
      },
    });
    const first = submit(executor, OP_A, send(), "pane.source", firstGuard);
    const replay = submit(executor, OP_A, send(), "pane.source", replayGuard);
    expect(replay).toBe(first);
    await vi.waitFor(() => expect(started).toEqual([OP_A]));
    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await expect(Promise.all([first, replay])).resolves.toHaveLength(2);
    expect(firstGuard).toHaveBeenCalledOnce();
    expect(replayGuard).not.toHaveBeenCalled();
    await executor.dispose();
  });

  it("keeps one strict FIFO through tmux observation for each session", async () => {
    const started: string[] = [];
    const { executor, receipts } = rig({
      execute: (operationId, intent) => {
        started.push(operationId);
        return resultFor(operationId, intent);
      },
    });
    const first = submit(executor, OP_A, send());
    const second = submit(executor, OP_B, send("alpha", "pane.beta"));

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

  it("keeps send, structural mutation, read, and split in one mixed FIFO", async () => {
    const started: string[] = [];
    const { executor } = rig({
      execute: (id, intent) => {
        started.push(intent.verb);
        return resultFor(id, intent);
      },
    });
    const sent = submit(executor, operationId(20), send());
    const resized = submit(executor, operationId(21), {
      verb: "workspace.pane.resize",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      axis: "cols",
      cells: 80,
    });
    const read = submit(executor, operationId(22), {
      verb: "workspace.pane.read",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      origin: "sdk",
    });
    const split = submit(executor, operationId(23), {
      verb: "workspace.window.split",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      direction: "down",
    });
    await vi.waitFor(() => expect(started).toEqual(["workspace.pane.send"]));
    executor.observe({
      operationId: operationId(20),
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await sent;
    await resized;
    await vi.waitFor(() =>
      expect(started).toEqual([
        "workspace.pane.send",
        "workspace.pane.resize",
        "workspace.pane.read",
      ]),
    );
    executor.observe({
      operationId: operationId(22),
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.read",
    });
    await Promise.all([read, split]);
    expect(started).toEqual([
      "workspace.pane.send",
      "workspace.pane.resize",
      "workspace.pane.read",
      "workspace.window.split",
    ]);
    await executor.dispose();
  });

  it("replays a settled structural result from the sole ledger without another effect", async () => {
    const execute = vi.fn((id: string, intent: ExecutableSessionRuntimeIntent) =>
      resultFor(id, intent),
    );
    const { executor, receipts } = rig({ execute });
    const intent = {
      verb: "workspace.pane.resize",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      axis: "cols",
      cells: 80,
    } as const;
    const first = await submit(executor, OP_A, intent);
    const retry = await submit(executor, OP_A, intent);
    expect(execute).toHaveBeenCalledOnce();
    expect(first).toMatchObject({ outcome: "applied", cells: 72 });
    expect(retry).toMatchObject({ outcome: "replayed", cells: 72 });
    expect(receipts.map(({ phase }) => phase)).toEqual(["accepted", "observed"]);
    await executor.dispose();
  });

  it("allows different tmux sessions to progress independently", async () => {
    const started: string[] = [];
    const { executor } = rig({
      execute: (operationId, intent) => {
        started.push(operationId);
        return resultFor(operationId, intent);
      },
    });
    const alpha = submit(executor, OP_A, send("alpha", "pane.alpha"));
    const beta = submit(executor, OP_B, send("beta", "pane.beta"));
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

  it("keeps a saturated alpha ledger from rejecting a healthy beta mutation", async () => {
    const execute = vi.fn((id: string, intent: ExecutableSessionRuntimeIntent) =>
      resultFor(id, intent),
    );
    const { executor } = rig({ execute });
    const alphaPending = Array.from(
      { length: SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY },
      (_, index) => submit(executor, operationId(index + 1), send("alpha", "pane.alpha")),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await expect(
      submit(executor, operationId(10_000), send("alpha", "pane.alpha")),
    ).rejects.toMatchObject({ outcome: "rejected" });
    await expect(
      submit(executor, operationId(10_001), {
        verb: "workspace.pane.resize",
        workspaceName: "beta",
        semanticPaneId: "pane.beta",
        axis: "cols",
        cells: 80,
      }),
    ).resolves.toMatchObject({ workspaceName: "beta", outcome: "applied" });
    expect(execute).toHaveBeenCalledTimes(2);
    const outcomes = Promise.allSettled(alphaPending);
    await executor.dispose();
    expect((await outcomes).every(({ status }) => status === "rejected")).toBe(true);
  });

  it("scopes the same operation id and pending observation independently per session", async () => {
    const started: string[] = [];
    const { executor } = rig({
      execute: (id, intent) => {
        started.push(intent.workspaceName);
        return resultFor(id, intent);
      },
    });
    const alpha = submit(executor, OP_A, send("alpha", "pane.alpha"));
    const beta = submit(executor, OP_A, send("beta", "pane.beta"));
    await vi.waitFor(() => expect(new Set(started)).toEqual(new Set(["alpha", "beta"])));
    executor.observe({
      operationId: OP_A,
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

  it("keeps authorization synchronously adjacent to the lower tmux effect", async () => {
    const order: string[] = [];
    const { executor } = rig({
      execute: (id, intent) => {
        order.push("effect");
        return resultFor(id, intent);
      },
    });
    const completed = submit(
      executor,
      OP_A,
      {
        verb: "workspace.pane.resize",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        axis: "cols",
        cells: 80,
      },
      null,
      () => {
        order.push("authorize");
        queueMicrotask(() => order.push("microtask"));
      },
    );
    await completed;
    expect(order.slice(0, 2)).toEqual(["authorize", "effect"]);
    expect(order).toEqual(["authorize", "effect", "microtask"]);
    await executor.dispose();
  });

  it("includes trusted out-of-band origin in the replay fingerprint", async () => {
    const execute = vi.fn((id: string, intent: ExecutableSessionRuntimeIntent) =>
      resultFor(id, intent),
    );
    const { executor } = rig({ execute });
    const intent = {
      verb: "workspace.pane.resize",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      axis: "cols",
      cells: 80,
    } as const;
    await submit(executor, OP_A, intent, null, undefined, "gui");
    await expect(submit(executor, OP_A, intent, null, undefined, "tui")).rejects.toMatchObject({
      outcome: "rejected",
    });
    expect(execute).toHaveBeenCalledOnce();
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

    const submitted = submit(executor, OP_A, send());
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
    const execute = vi.fn((operationId: string, intent: ExecutableSessionRuntimeIntent) =>
      resultFor(operationId, intent),
    );
    const { executor, receipts } = rig({ execute });
    const first = submit(executor, OP_A, send());
    const retry = submit(executor, OP_A, send());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    executor.observe({
      operationId: OP_A,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      operationKind: "workspace.pane.send",
    });
    await Promise.all([first, retry]);
    await submit(executor, OP_A, send());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(receipts.map((receipt) => receipt.phase)).toEqual(["accepted", "observed"]);
    await executor.dispose();
  });

  it("rejects conflicting operation ids without replacing the active execution", async () => {
    const execute = vi.fn((operationId: string, intent: ExecutableSessionRuntimeIntent) =>
      resultFor(operationId, intent),
    );
    const { executor, receipts } = rig({ execute });
    const first = submit(executor, OP_A, send());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    await expect(
      submit(executor, OP_A, { ...send(), semanticPaneId: "pane.other" }),
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
    const execute = vi.fn((id: string, intent: ExecutableSessionRuntimeIntent) => {
      queueMicrotask(() => {
        executor.observe({
          operationId: id,
          workspaceName: intent.workspaceName,
          semanticPaneId: intent.semanticPaneId,
          operationKind: intent.verb,
        });
      });
      return resultFor(id, intent);
    });
    const built = rig({ execute });
    executor = built.executor;

    for (let index = 1; index <= SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY + 1; index += 1) {
      await submit(executor, operationId(index), send());
    }

    expect(execute).toHaveBeenCalledTimes(SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY + 1);
    expect(built.receipts).toHaveLength((SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY + 1) * 2);
    await executor.dispose();
  });

  it("never evicts pending records and backpressures only when every slot is active", async () => {
    const execute = vi.fn((operationId: string, intent: ExecutableSessionRuntimeIntent) =>
      resultFor(operationId, intent),
    );
    const { executor, receipts } = rig({ execute });
    const pending = Array.from({ length: SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY }, (_, index) =>
      submit(executor, operationId(index + 1), send()),
    );
    const firstRetry = submit(executor, operationId(1), send());
    expect(firstRetry).toBe(pending[0]);

    await expect(
      submit(executor, operationId(SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY + 1), send()),
    ).rejects.toMatchObject({ outcome: "rejected" });
    expect(receipts).toHaveLength(SESSION_RUNTIME_OPERATION_LEDGER_CAPACITY);

    const outcomes = Promise.allSettled(pending);
    await executor.dispose();
    expect((await outcomes).every((outcome) => outcome.status === "rejected")).toBe(true);
  });

  it("publishes rejected when authority refuses and timed-out without tmux truth", async () => {
    const rejected = rig({
      execute: () => {
        throw new Error("no pane");
      },
    });
    await expect(submit(rejected.executor, OP_A, send())).rejects.toMatchObject({
      outcome: "rejected",
    });
    expect(rejected.receipts.map((receipt) => receipt.phase)).toEqual(["accepted", "rejected"]);
    await rejected.executor.dispose();

    const timedOut = rig({ timeout: 5 });
    await expect(submit(timedOut.executor, OP_B, send())).rejects.toMatchObject({
      outcome: "timed-out",
    });
    expect(timedOut.receipts.map((receipt) => receipt.phase)).toEqual(["accepted", "timed-out"]);
    await timedOut.executor.dispose();
  });

  it("rejects a structural success that cannot produce verb-matched proof", async () => {
    const broken = rig({ execute: () => undefined });
    await expect(
      submit(broken.executor, OP_A, {
        verb: "workspace.pane.resize",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        axis: "cols",
        cells: 80,
      }),
    ).rejects.toMatchObject({ outcome: "rejected" });
    expect(broken.receipts.map(({ phase }) => phase)).toEqual(["accepted", "rejected"]);
    await broken.executor.dispose();
  });

  it("rejects a structural authority refusal without entering the observation timeout lane", async () => {
    const refused = rig({
      execute: () => {
        throw new Error("resize refused");
      },
      timeout: 1,
    });
    await expect(
      submit(refused.executor, OP_A, {
        verb: "workspace.pane.resize",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        axis: "cols",
        cells: 80,
      }),
    ).rejects.toMatchObject({ outcome: "rejected" });
    expect(refused.receipts.map(({ phase }) => phase)).toEqual(["accepted", "rejected"]);
    await refused.executor.dispose();
  });

  it("replays one remembered structural refusal without another effect or lifecycle", async () => {
    const failure = new Error("resize refused");
    const execute = vi.fn(() => {
      throw failure;
    });
    const { executor, receipts } = rig({ execute });
    const intent = {
      verb: "workspace.pane.resize",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      axis: "cols",
      cells: 80,
    } as const;
    const first = await submit(executor, OP_A, intent).catch((error: unknown) => error);
    const retry = await submit(executor, OP_A, intent).catch((error: unknown) => error);
    expect(retry).toBe(first);
    expect(execute).toHaveBeenCalledOnce();
    expect(receipts.map(({ phase }) => phase)).toEqual(["accepted", "rejected"]);
    await executor.dispose();
  });

  it("settles in-flight and queued work deterministically on shutdown", async () => {
    const started: string[] = [];
    const { executor, receipts } = rig({
      execute: (operationId, intent) => {
        started.push(operationId);
        return resultFor(operationId, intent);
      },
    });
    const first = submit(executor, OP_A, send());
    const second = submit(executor, OP_B, send("alpha", "pane.beta"));
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
