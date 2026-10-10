import { expect, it } from "vitest";
import { testInteractionContext } from "../../../test-support/interaction-evidence.ts";
import { SessionSemanticMutationExecutor } from "./semantic-mutation-executor.ts";

const operationId = "11111111-1111-4111-8111-111111111111";

it.each(["valid", "revoked", "replaced"] as const)(
  "rechecks final effect authority after asynchronous preparation: %s",
  async (scenario) => {
    const intent = {
      verb: "workspace.pane.read" as const,
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      origin: "sdk" as const,
    };
    const captured = testInteractionContext(intent);
    let authorized = true;
    let contextCurrent = true;
    let effects = 0;
    let validations = 0;
    let authorizations = 0;
    let sequence = 0;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const executor = new SessionSemanticMutationExecutor({
      captureInteractionContext: () => captured,
      validateInteractionContext: (context) => {
        expect(context).toEqual(captured);
        validations++;
        if (!contextCurrent) throw new Error("captured context replaced");
      },
      resolveSession: () => "session-alpha",
      execute: async (_id, _intent, _timing, _execution, authorizeBeforeEffect) => {
        entered.resolve();
        await resume.promise;
        expect(authorizeBeforeEffect).toBeTypeOf("function");
        authorizeBeforeEffect!();
        effects++;
      },
      publishReceipt: (receipt) => ({
        ...receipt,
        type: "interaction.receipt",
        sequence: ++sequence,
      }),
    });
    const pending = executor.submit(operationId, intent, {
      origin: "sdk",
      authorizeBeforeEffect: () => {
        authorizations++;
        if (!authorized) throw new Error("authority revoked");
      },
    });
    // Observe rejection immediately, including if the deferred owner fails.
    const outcome = pending.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await entered.promise;
      expect(validations).toBe(1);
      expect(authorizations).toBe(1);
      expect(effects).toBe(0);
      if (scenario === "revoked") authorized = false;
      if (scenario === "replaced") contextCurrent = false;
      executor.observe({
        operationId,
        workspaceName: intent.workspaceName,
        semanticPaneId: intent.semanticPaneId,
        operationKind: intent.verb,
      });
      resume.resolve();
      const result = await outcome;
      expect(result.ok).toBe(scenario === "valid");
      expect(effects).toBe(scenario === "valid" ? 1 : 0);
      expect(validations).toBe(2);
      expect(authorizations).toBe(scenario === "replaced" ? 1 : 2);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          outcome: "rejected",
          cause: {
            message: scenario === "revoked" ? "authority revoked" : "captured context replaced",
          },
        });
      }
    } finally {
      resume.resolve();
      await executor.dispose();
    }
  },
);

it.each([true, false])(
  "forwards final authorization for resize without authored context (allowed=%s)",
  async (allowed) => {
    let authorized = true;
    let effects = 0;
    let sequence = 0;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const executor = new SessionSemanticMutationExecutor({
      resolveSession: () => "session-alpha",
      execute: async (_id, _intent, _timing, execution, authorizeBeforeEffect) => {
        expect(execution).toBeUndefined();
        entered.resolve();
        await resume.promise;
        expect(authorizeBeforeEffect).toBeTypeOf("function");
        authorizeBeforeEffect!();
        effects++;
        return {
          operationId,
          daemonInstanceId: operationId,
          workspaceName: "alpha",
          outcome: "applied" as const,
          verb: "workspace.pane.resize" as const,
          semanticPaneId: "pane.alpha",
          axis: "cols" as const,
          cells: 80,
        };
      },
      publishReceipt: (receipt) => ({
        ...receipt,
        type: "interaction.receipt",
        sequence: ++sequence,
      }),
    });
    const result = executor
      .submit(
        operationId,
        {
          verb: "workspace.pane.resize",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
          axis: "cols",
          cells: 80,
        },
        {
          origin: "sdk",
          authorizeBeforeEffect: () => {
            if (!authorized) throw new Error("geometry authority revoked");
          },
        },
      )
      .then(
        () => true,
        () => false,
      );
    try {
      await entered.promise;
      authorized = allowed;
      resume.resolve();
      expect(await result).toBe(allowed);
      expect(effects).toBe(allowed ? 1 : 0);
    } finally {
      resume.resolve();
      await executor.dispose();
    }
  },
);

it.each(["disposed", "settled", "failed"] as const)(
  "retires final-effect authorization when execution is %s",
  async (scenario) => {
    let effects = 0;
    let sequence = 0;
    let authorizations = 0;
    let finalGuard: (() => void) | undefined;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const executor = new SessionSemanticMutationExecutor({
      resolveSession: () => "session-alpha",
      execute: async (_id, _intent, _timing, _execution, guard) => {
        finalGuard = guard;
        entered.resolve();
        await resume.promise;
        if (scenario === "failed") throw new Error("preparation failed");
        guard!();
        effects++;
        return {
          operationId,
          daemonInstanceId: operationId,
          workspaceName: "alpha",
          outcome: "applied" as const,
          verb: "workspace.pane.resize" as const,
          semanticPaneId: "pane.alpha",
          axis: "cols" as const,
          cells: 80,
        };
      },
      publishReceipt: (receipt) => ({
        ...receipt,
        type: "interaction.receipt",
        sequence: ++sequence,
      }),
    });
    const pending = executor
      .submit(
        operationId,
        {
          verb: "workspace.pane.resize",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
          axis: "cols",
          cells: 80,
        },
        {
          origin: "sdk",
          authorizeBeforeEffect: () => {
            authorizations++;
          },
        },
      )
      .then(
        () => true,
        () => false,
      );
    let disposal: Promise<void> | undefined;
    try {
      await entered.promise;
      if (scenario === "disposed") disposal = executor.dispose();
      resume.resolve();
      expect(await pending).toBe(scenario === "settled");
      expect(effects).toBe(scenario === "settled" ? 1 : 0);
      const before = authorizations;
      expect(finalGuard).toBeTypeOf("function");
      expect(() => finalGuard!()).toThrow("Semantic execution authority is no longer active");
      expect(authorizations).toBe(before);
      expect(authorizations).toBe(scenario === "settled" ? 2 : 1);
    } finally {
      resume.resolve();
      await disposal;
      await executor.dispose();
    }
  },
);
