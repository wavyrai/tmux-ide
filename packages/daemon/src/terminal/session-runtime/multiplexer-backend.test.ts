import type {
  SessionRuntimeSemanticIntent,
  WorkspaceMultiplexerMutationRequest,
  WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SessionRuntimeConsumer, SessionRuntimeControllerLease } from "./registry.ts";
import { createSessionRuntimeMultiplexerBackend } from "./multiplexer-backend.ts";

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

describe("createSessionRuntimeMultiplexerBackend", () => {
  it("routes every command-center multiplexer verb through one runtime controller consumer", async () => {
    const lease: SessionRuntimeControllerLease = {
      generation: GENERATION,
      session: "alpha-session",
      clientId: `command-center:${GENERATION}:alpha-session`,
      token: "22222222-2222-4222-8222-222222222222",
      revision: 1,
    };
    const submitted: SessionRuntimeSemanticIntent[] = [];
    const consumer = {
      acquireController: vi.fn(() => lease),
      submitIntent: vi.fn(async (_lease, _operationId, intent) => {
        submitted.push(intent);
        return { outcome: "applied" } as WorkspaceMultiplexerMutationResult;
      }),
    } as unknown as SessionRuntimeConsumer;
    const connect = vi.fn(() => consumer);
    const backend = createSessionRuntimeMultiplexerBackend({
      registry: { generation: GENERATION, connect },
      resolveSession: (workspaceName) => (workspaceName === "alpha" ? "alpha-session" : null),
    });

    const verbs = intents();
    for (const [index, intent] of verbs.entries()) {
      await backend.mutate({
        operationId: OPERATION_IDS[index]!,
        expectedDaemonInstanceId: GENERATION,
        intent,
      } as WorkspaceMultiplexerMutationRequest);
    }

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(
      "alpha-session",
      "command-center",
      `command-center:${GENERATION}:alpha-session`,
    );
    expect(consumer.acquireController).toHaveBeenCalledTimes(verbs.length);
    expect(submitted.map((intent) => intent.verb)).toEqual(verbs.map((intent) => intent.verb));
  });
});
