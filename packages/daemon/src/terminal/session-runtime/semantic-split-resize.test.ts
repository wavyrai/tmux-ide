import { WorkspaceMultiplexerError } from "../../lib/workspace-multiplexer-verbs.ts";
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SessionSemanticMutationExecutor } from "./semantic-mutation-executor.ts";
import type { InteractionReceipt } from "@tmux-ide/contracts";
const generation = randomUUID();
const intent = {
  verb: "workspace.window.split.resize" as const,
  workspaceName: "test",
  target: {
    window: {
      liveSessionId: `live-session.${"a".repeat(20)}`,
      linkId: `window-link.${"b".repeat(32)}`,
      linkRevision: 0,
      expectedSemanticWindowId: "window.test",
    },
    layoutId: randomUUID(),
    splitId: randomUUID(),
    boundary: 0,
  },
};
it("serializes split mutations, deduplicates exact operations and publishes clamped structural proof", async () => {
  const releases: Array<() => void> = [];
  const order: string[] = [];
  const receipts: InteractionReceipt[] = [];
  const execute = vi.fn(async (id, request, _timing, _context, authorize) => {
    order.push(id);
    await new Promise<void>((resolve) => releases.push(resolve));
    authorize();
    return {
      operationId: id,
      daemonInstanceId: generation,
      workspaceName: "test",
      verb: request.verb,
      outcome: "applied",
      target: request.target,
      axis: "cols",
      boundary: 3,
    } as const;
  });
  const executor = new SessionSemanticMutationExecutor({
    resolveSession: () => "test",
    execute,
    publishReceipt: (draft) => {
      const receipt = {
        type: "interaction.receipt" as const,
        sequence: receipts.length + 1,
        ...draft,
      };
      receipts.push(receipt);
      return receipt;
    },
  });
  const one = randomUUID(),
    two = randomUUID();
  try {
    const a = executor.submit(one, intent, { origin: "gui" });
    const duplicate = executor.submit(one, intent, { origin: "gui" });
    const b = executor.submit(two, intent, { origin: "gui" });
    await vi.waitFor(() => expect(order).toEqual([one]));
    releases.shift()!();
    await a;
    await duplicate;
    await vi.waitFor(() => expect(order).toEqual([one, two]));
    releases.shift()!();
    await b;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(receipts.filter((r) => r.phase === "observed")).toHaveLength(2);
    expect(receipts.find((r) => r.phase === "observed")?.proof).toMatchObject({
      operationKind: intent.verb,
      target: intent.target,
      boundary: 3,
      axis: "cols",
    });
    await expect(
      executor.submit(
        one,
        { ...intent, target: { ...intent.target, boundary: 50 } },
        { origin: "gui" },
      ),
    ).rejects.toThrow();
  } finally {
    releases.forEach((release) => release());
    await executor.dispose();
  }
});

it("keeps an uncertain operation terminal and never redispatches a duplicate", async () => {
  const execute = vi.fn(() => {
    throw new WorkspaceMultiplexerError("mutation_unverified");
  });
  const executor = new SessionSemanticMutationExecutor({
    resolveSession: () => "test",
    execute,
    publishReceipt: (draft) => ({ type: "interaction.receipt", sequence: 1, ...draft }),
  });
  try {
    const id = randomUUID();
    for (let i = 0; i < 2; i++)
      await expect(executor.submit(id, intent, { origin: "gui" })).rejects.toThrow(
        "outcome is uncertain",
      );
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await executor.dispose();
  }
});
