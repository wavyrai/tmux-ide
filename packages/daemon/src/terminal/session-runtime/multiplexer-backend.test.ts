import type {
  SessionRuntimeSemanticIntent,
  WorkspaceMultiplexerMutationRequest,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionRuntimeConsumer,
  SessionRuntimeControllerLease,
  SessionRuntimeExecutionHandle,
} from "./registry.ts";
import { SessionRuntimeRegistry } from "./registry.ts";
import { createSessionRuntimeMultiplexerBackend } from "./multiplexer-backend.ts";
import { WorkspaceMultiplexerError } from "../../lib/workspace-multiplexer-verbs.ts";
import { SessionRuntimeIntentError } from "./semantic-mutation-executor.ts";
import { SessionRuntimeTransportBinder } from "./transport-binding.ts";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OPERATION_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008",
  "00000000-0000-4000-8000-000000000009",
  "00000000-0000-4000-8000-000000000010",
] as const;

function intents(): readonly SessionRuntimeSemanticIntent[] {
  return [
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
    {
      verb: "workspace.pane.send",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      text: "hello",
      submit: true,
      origin: "gui",
    },
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
  ];
}

function request(
  intent: SessionRuntimeSemanticIntent,
  operationId = OPERATION_IDS[0],
): WorkspaceMultiplexerMutationRequest {
  return { operationId, expectedDaemonInstanceId: GENERATION, intent };
}

function rig() {
  const lease: SessionRuntimeControllerLease = {
    generation: GENERATION,
    session: "alpha-session",
    clientId: "placeholder",
    token: "22222222-2222-4222-8222-222222222222",
    revision: 1,
  };
  const handleStates = new WeakMap<object, { readonly allowed: ReadonlySet<string> }>();
  const acquireController = vi.fn(function (this: SessionRuntimeConsumer) {
    return { ...lease, clientId: this.clientId };
  });
  const releaseController = vi.fn();
  const submitIntent = vi.fn(async () => ({ outcome: "applied" }));
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(
    (session: string, surface: string, clientId: string) =>
      ({
        generation: GENERATION,
        session,
        surface,
        clientId,
        acquireController,
        releaseController,
        submitIntent,
        close,
      }) as unknown as SessionRuntimeConsumer,
  );
  const submitAuthenticatedIntent = vi.fn(async () => ({ outcome: "applied" }));
  const submitPaneCredentialIntent = vi.fn(
    async (
      _session: string,
      _operationId: string,
      intent: SessionRuntimeSemanticIntent,
      _source: string,
      authorizeBeforeEffect?: () => void,
    ) => {
      if (intent.verb !== "workspace.pane.send") {
        throw new Error("Pane credentials authorize pane sends only");
      }
      authorizeBeforeEffect?.();
      return { outcome: "applied" };
    },
  );
  const registry = {
    generation: GENERATION,
    connect,
    createExecutionHandle: vi.fn(
      (_consumer, _controllerLease, allowedSourcePaneIds: readonly string[]) => {
        const handle = Object.freeze(Object.create(null)) as SessionRuntimeExecutionHandle;
        handleStates.set(handle, { allowed: new Set(allowedSourcePaneIds) });
        return handle;
      },
    ),
    bindExecutionSource: vi.fn((handle: SessionRuntimeExecutionHandle, paneId: string) => {
      const state = handleStates.get(handle);
      if (!state?.allowed.has(paneId)) throw new Error("invalid source grant");
      const bound = Object.freeze(Object.create(null)) as SessionRuntimeExecutionHandle;
      handleStates.set(bound, state);
      return bound;
    }),
    assertExecutionHandle: vi.fn((handle: SessionRuntimeExecutionHandle, paneId?: string) => {
      const state = handleStates.get(handle);
      if (!state || (paneId !== undefined && !state.allowed.has(paneId))) {
        throw new Error("invalid execution handle");
      }
    }),
    submitAuthenticatedIntent,
    submitPaneCredentialIntent,
  } as unknown as SessionRuntimeRegistry;
  const resolvePaneSourceCredential = vi.fn(
    (credential: string | undefined, session: string, claimed: string | undefined) =>
      credential === "valid-pane-token" &&
      session === "alpha-session" &&
      (claimed === undefined || claimed === "pane.source")
        ? "pane.source"
        : null,
  );
  const backend = createSessionRuntimeMultiplexerBackend({
    registry,
    resolveSession: (workspaceName) => (workspaceName === "alpha" ? "alpha-session" : null),
    resolvePaneSourceCredential,
  });
  return {
    acquireController,
    backend,
    close,
    connect,
    registry,
    resolvePaneSourceCredential,
    submitAuthenticatedIntent,
    submitIntent,
    submitPaneCredentialIntent,
  };
}

describe("createSessionRuntimeMultiplexerBackend", () => {
  it("shares one bounded owner for concurrent same-operation retries", async () => {
    const h = rig();
    const mutation = request({
      verb: "workspace.pane.resize",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      axis: "cols",
      cells: 80,
    });
    await Promise.all([
      h.backend.mutate(mutation, undefined, undefined, true),
      h.backend.mutate(mutation, undefined, undefined, true),
    ]);
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.submitIntent).toHaveBeenCalledTimes(2);
    expect(h.submitIntent.mock.calls.map((call) => call[1])).toEqual([
      OPERATION_IDS[0],
      OPERATION_IDS[0],
    ]);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it("leaves no owner controller behind, so a GUI can acquire immediately", async () => {
    const registry = new SessionRuntimeRegistry({
      generation: GENERATION,
      semanticMutations: {
        resolveSession: () => "alpha-session",
        execute: (operationId, intent) => {
          if (intent.verb !== "workspace.pane.resize") throw new Error("unexpected intent");
          return {
            operationId,
            daemonInstanceId: GENERATION,
            workspaceName: intent.workspaceName,
            verb: intent.verb,
            outcome: "applied",
            semanticPaneId: intent.semanticPaneId,
            axis: intent.axis,
            cells: intent.cells,
          };
        },
        publishReceipt: (receipt) => ({ type: "interaction.receipt", sequence: 1, ...receipt }),
      },
    });
    const backend = createSessionRuntimeMultiplexerBackend({
      registry,
      resolveSession: () => "alpha-session",
    });
    await backend.mutate(
      request({
        verb: "workspace.pane.resize",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        axis: "cols",
        cells: 80,
      }),
      undefined,
      undefined,
      true,
    );
    expect(registry.activeControllerLeaseCount()).toBe(0);
    const gui = registry.connect("alpha-session", "terminal-attachment", "host:gui");
    expect(gui.acquireController()).toMatchObject({ clientId: "host:gui" });
    await gui.close();
    await registry.dispose();
  });

  it("preserves typed multiplexer refusals but retains the runtime envelope for generic failures", async () => {
    const refusal = new WorkspaceMultiplexerError("single_pane_window");
    const build = (failure: Error) => {
      const registry = new SessionRuntimeRegistry({
        generation: GENERATION,
        semanticMutations: {
          resolveSession: () => "alpha-session",
          execute: () => {
            throw failure;
          },
          publishReceipt: (receipt) => ({ type: "interaction.receipt", sequence: 1, ...receipt }),
        },
      });
      return {
        registry,
        backend: createSessionRuntimeMultiplexerBackend({
          registry,
          resolveSession: () => "alpha-session",
        }),
      };
    };
    const typed = build(refusal);
    await expect(
      typed.backend.mutate(
        request({
          verb: "workspace.pane.resize",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
          axis: "cols",
          cells: 80,
        }),
        undefined,
        undefined,
        true,
      ),
    ).rejects.toBe(refusal);
    await typed.registry.dispose();

    const generic = build(new Error("generic effect failure"));
    await expect(
      generic.backend.mutate(
        request({
          verb: "workspace.pane.resize",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
          axis: "cols",
          cells: 80,
        }),
        undefined,
        undefined,
        true,
      ),
    ).rejects.toBeInstanceOf(SessionRuntimeIntentError);
    await generic.registry.dispose();
  });

  it("keeps anonymous owner access explicit and releases authority after each settled action", async () => {
    const h = rig();
    const verbs = intents();
    for (const [index, intent] of verbs.entries()) {
      await h.backend.mutate(request(intent, OPERATION_IDS[index]!), undefined, undefined, true);
    }

    expect(h.connect).toHaveBeenCalledTimes(verbs.length);
    expect(h.connect.mock.calls[0]).toEqual([
      "alpha-session",
      "command-center",
      `command-center:${GENERATION}:alpha-session:1`,
    ]);
    expect(h.acquireController).toHaveBeenCalledTimes(verbs.length);
    expect(h.close).toHaveBeenCalledTimes(verbs.length);
    expect(h.submitIntent.mock.calls.map((call) => call[2].verb)).toEqual(
      verbs.map((intent) => intent.verb),
    );
    expect(
      h.submitIntent.mock.calls.find((call) => call[2].verb === "workspace.pane.send")?.[2],
    ).toMatchObject({ origin: "gui" });
  });

  it("uses an exact live authenticated host grant and never manufactures an owner", async () => {
    const h = rig();
    const binding = new SessionRuntimeTransportBinder(h.registry).bind({
      transport: "terminal-attachment",
      transportLeaseId: "33333333-3333-4333-8333-333333333333",
      session: "alpha-session",
      hostClientId: "host-a",
      allowedSourcePaneIds: ["pane.source"],
      interactive: true,
    });
    const intent = {
      verb: "workspace.pane.send",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      sourceSemanticPaneId: "pane.source",
      text: "run tests",
      submit: true,
      origin: "sdk",
    } as const;

    await h.backend.mutate(request(intent), "host-a");
    expect(h.submitAuthenticatedIntent).toHaveBeenCalledOnce();
    expect(h.submitAuthenticatedIntent.mock.calls[0]![2]).toEqual(intent);
    expect(h.submitIntent).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledTimes(1);
    await binding.close();
  });

  it("fails closed for a stale or under-granted authenticated host", async () => {
    const h = rig();
    const intent = {
      verb: "workspace.pane.send",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      sourceSemanticPaneId: "pane.source",
      text: "run tests",
      submit: true,
      origin: "gui",
    } as const;

    await expect(h.backend.mutate(request(intent), "stale-host")).rejects.toThrow(
      "no live controller grant",
    );
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.submitIntent).not.toHaveBeenCalled();
    expect(h.submitAuthenticatedIntent).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid pane credential without anonymous fallback", async () => {
    const h = rig();
    const intent = {
      verb: "workspace.pane.send",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      sourceSemanticPaneId: "pane.source",
      text: "run tests",
      submit: true,
      origin: "gui",
    } as const;

    await expect(h.backend.mutate(request(intent), undefined, "forged-token")).rejects.toThrow(
      "invalid or stale",
    );
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.submitPaneCredentialIntent).not.toHaveBeenCalled();
  });

  it("rejects a direct semantic mutation with no authenticated principal", async () => {
    const h = rig();
    await expect(
      h.backend.mutate(
        request({
          verb: "workspace.pane.resize",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
          axis: "cols",
          cells: 80,
        }),
      ),
    ).rejects.toThrow("requires a live host, pane, or owner principal");
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.submitIntent).not.toHaveBeenCalled();
  });

  it("re-resolves a pane credential at the final effect boundary", async () => {
    const h = rig();
    const effect = vi.fn();
    h.submitPaneCredentialIntent.mockImplementationOnce(
      async (_session, _operationId, _intent, _source, authorizeBeforeEffect) => {
        h.resolvePaneSourceCredential.mockReturnValue(null);
        authorizeBeforeEffect?.();
        effect();
        return { outcome: "applied" };
      },
    );
    await expect(
      h.backend.mutate(
        request({
          verb: "workspace.pane.send",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
          sourceSemanticPaneId: "pane.source",
          text: "never delivered",
          submit: true,
          origin: "sdk",
        }),
        undefined,
        "valid-pane-token",
      ),
    ).rejects.toThrow("became invalid before execution");
    expect(effect).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it("allows a valid headless credential to send only, without borrowing a controller", async () => {
    const h = rig();
    const send = {
      verb: "workspace.pane.send",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      sourceSemanticPaneId: "pane.source",
      text: "run tests",
      submit: true,
      origin: "cli",
    } as const;
    await h.backend.mutate(request(send), undefined, "valid-pane-token");
    expect(h.submitPaneCredentialIntent).toHaveBeenCalledWith(
      "alpha-session",
      OPERATION_IDS[0],
      { ...send, origin: "cli" },
      "pane.source",
      expect.any(Function),
    );
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.acquireController).not.toHaveBeenCalled();

    await expect(
      h.backend.mutate(
        request({
          verb: "workspace.pane.resize",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
          axis: "cols",
          cells: 80,
        }),
        undefined,
        "valid-pane-token",
      ),
    ).rejects.toThrow("pane sends only");
    expect(h.connect).not.toHaveBeenCalled();
  });
});
