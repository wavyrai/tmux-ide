import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { InteractionReceipt, SessionRuntimeSemanticIntent } from "@tmux-ide/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TmuxExternalInteractionObserver } from "../../lib/tmux-external-interaction-observer.ts";
import { WorkspaceMultiplexerAuthority } from "../../lib/workspace-multiplexer-verbs.ts";
import { WorkspacePaneCreationAuthority } from "../../lib/workspace-pane-creation.ts";
import { createActionDispatcher } from "../../command-center/actions/dispatcher.ts";
import { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { createSessionRuntimeMultiplexerBackend } from "./multiplexer-backend.ts";
import { SessionRuntimeRegistry } from "./registry.ts";
import { SessionRuntimeTransportBinder } from "./transport-binding.ts";

const tmuxPath = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
const hasTmux = tmuxPath.length > 0;

describe.skipIf(!hasTmux).sequential("semantic mutation production cutover, live tmux", () => {
  const sockets: string[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      spawnSync(tmuxPath, ["-L", socket, "kill-server"], { stdio: "ignore" });
    }
  });

  it("executes a mixed FIFO once and publishes one accepted plus one verified terminal receipt", async () => {
    const socket = `zz-m56-cutover-${process.pid}-${randomUUID().slice(0, 8)}`;
    const session = `m56-cutover-${randomUUID().slice(0, 8)}`;
    const generation = randomUUID();
    const workspaceName = "cutover.workspace";
    const effectFile = join(tmpdir(), `tmux-ide-m56-effect-${randomUUID()}`);
    const readyFile = join(tmpdir(), `tmux-ide-m56-ready-${randomUUID()}`);
    sockets.push(socket);
    writeFileSync(effectFile, "");
    writeFileSync(readyFile, "");
    const run = (args: readonly string[]): string => {
      const result = spawnSync(tmuxPath, ["-L", socket, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || `tmux ${args[0]} failed`);
      return result.stdout;
    };

    const firstPane = run([
      "new-session",
      "-d",
      "-x",
      "120",
      "-y",
      "40",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      session,
      "-n",
      "main",
      `printf r > '${readyFile}'; exec /bin/sh`,
    ]).trim();
    const secondPane = run([
      "split-window",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      firstPane,
    ]).trim();
    const auxPane = run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      `=${session}`,
      "-n",
      "aux",
    ]).trim();
    run(["set-option", "-p", "-t", firstPane, "@tmux_ide_pane_id", "pane.editor"]);
    run(["set-option", "-p", "-t", secondPane, "@tmux_ide_pane_id", "pane.tests"]);
    run(["set-option", "-p", "-t", auxPane, "@tmux_ide_pane_id", "pane.aux"]);
    run(["set-option", "-w", "-t", firstPane, "@tmux_ide_window_id", "window.main"]);
    await vi.waitFor(() => expect(readFileSync(readyFile, "utf8")).toBe("r"), {
      timeout: 15_000,
    });

    const workspaceRegistry = new WorkspaceRegistry({
      dir: tmpdir(),
      listSessions: () => [session],
    });
    workspaceRegistry.add({ name: workspaceName, sessionName: session, projectDir: tmpdir() });
    const socketPath = run(["display-message", "-p", "#{socket_path}"]).trim();
    const tmuxAuthority = {
      executablePath: tmuxPath,
      socketSelector: { kind: "path" as const, path: socketPath },
    };
    const authority = new WorkspaceMultiplexerAuthority({
      daemonInstanceId: generation,
      registry: workspaceRegistry,
      tmuxAuthority,
    });
    const receipts: InteractionReceipt[] = [];
    const resourceChanges: Array<{
      workspaceName: string | null;
      resource: string;
      causeOperationId: string;
    }> = [];
    const executionOrder: string[] = [];
    let sequence = 0;
    let registry!: SessionRuntimeRegistry;
    registry = new SessionRuntimeRegistry({
      generation,
      semanticMutations: {
        resolveSession: (workspace) =>
          workspace === workspaceName
            ? (workspaceRegistry.get(workspace)?.sessionName ?? null)
            : null,
        execute: (operationId, intent) => {
          executionOrder.push(intent.verb);
          if (intent.verb === "workspace.pane.read") {
            authority.readPane(operationId, intent);
            return;
          }
          return authority.mutate({
            operationId,
            expectedDaemonInstanceId: generation,
            intent,
          });
        },
        publishReceipt: (receipt) => {
          const published = {
            type: "interaction.receipt",
            sequence: ++sequence,
            ...receipt,
          } as InteractionReceipt;
          receipts.push(published);
          return published;
        },
        publishResourceChange: (change) => resourceChanges.push(change),
        observationTimeoutMs: 5_000,
      },
    });
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: generation,
      tmuxAuthority,
      registry: workspaceRegistry,
      onObserved: (observation) =>
        observation.operationId === null
          ? false
          : registry.observeTmuxInteraction({
              operationId: observation.operationId,
              workspaceName: observation.workspaceName,
              semanticPaneId: observation.semanticPaneId,
              operationKind: observation.operationKind,
            }),
    });
    await observer.start();

    // Production-shaped owner path: create through the action dispatcher,
    // then reuse the exact already-bound OpenTUI controller for select and
    // rename. No anonymous command-center consumer may be manufactured while
    // that controller is held.
    const creation = new WorkspacePaneCreationAuthority({
      daemonInstanceId: generation,
      registry: workspaceRegistry,
      tmuxAuthority,
    });
    const backend = createSessionRuntimeMultiplexerBackend({
      registry,
      resolveSession: (workspace) =>
        workspace === workspaceName
          ? (workspaceRegistry.get(workspace)?.sessionName ?? null)
          : null,
    });
    const app = new Hono();
    app.post(
      "/api/v2/action/:name",
      createActionDispatcher({
        daemonInstanceId: generation,
        workspacePaneCreationBackend: creation,
        workspaceMultiplexerBackend: backend,
      }),
    );
    const post = async (
      action: string,
      operationId: string,
      body: unknown,
      hostClientId = "opentui:production-shaped",
    ) => {
      const response = await app.request(`http://localhost/api/v2/action/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tmux-Ide-Operation-Id": operationId,
          ...(hostClientId ? { "X-Tmux-Ide-Host-Client-Id": hostClientId } : {}),
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        ok: boolean;
        result?: Record<string, unknown>;
        error?: { code?: string };
      }>;
    };
    const createId = randomUUID();
    const created = await post("workspace.pane.create", createId, {
      kind: "terminal",
      workspaceName,
      displayTitle: "Lifecycle Two",
      placement: { kind: "window" },
    });
    expect(created).toMatchObject({ ok: true, result: { outcome: "created" } });
    const createdPane = created.result?.resource as { semanticPaneId?: string };
    expect(createdPane.semanticPaneId).toMatch(/^pane\./u);
    const binding = new SessionRuntimeTransportBinder(registry).bind({
      transport: "pane-stream",
      transportLeaseId: randomUUID(),
      session,
      hostClientId: "opentui:production-shaped",
      allowedSourcePaneIds: ["pane.editor", createdPane.semanticPaneId!],
      interactive: true,
      explicitAuthority: true,
    });
    expect(binding.requestAuthority("input")).not.toBeNull();
    const authorityBeforeActions = binding.authoritySnapshot();
    const selectId = randomUUID();
    expect(
      await post("workspace.pane.select", selectId, {
        workspaceName,
        semanticPaneId: createdPane.semanticPaneId,
      }),
    ).toMatchObject({ ok: true, result: { outcome: "applied" } });
    expect(resourceChanges).toEqual([
      { workspaceName, resource: "application-shell", causeOperationId: selectId },
      { workspaceName, resource: "workspace-missions", causeOperationId: selectId },
    ]);
    const staleRename = await post(
      "workspace.rename",
      randomUUID(),
      {
        workspaceName,
        scope: "window",
        target: { by: "pane", semanticPaneId: createdPane.semanticPaneId },
        name: "Must Not Apply",
      },
      "stale-host",
    );
    expect(staleRename).toMatchObject({ ok: false, error: { code: "operation_conflict" } });
    expect(resourceChanges).toHaveLength(2);
    expect(
      run(["list-panes", "-s", "-t", `=${session}`, "-F", "#{@tmux_ide_pane_id}\t#{window_name}"]),
    ).toContain(`${createdPane.semanticPaneId}\tLifecycle Two`);
    const renameId = randomUUID();
    expect(
      await post("workspace.rename", renameId, {
        workspaceName,
        scope: "window",
        target: { by: "pane", semanticPaneId: createdPane.semanticPaneId },
        name: "Lifecycle Renamed",
      }),
    ).toMatchObject({
      ok: true,
      result: { operationId: renameId, outcome: "applied", scope: "window" },
    });
    expect(resourceChanges.slice(2)).toEqual([
      { workspaceName, resource: "application-shell", causeOperationId: renameId },
      { workspaceName, resource: "workspace-missions", causeOperationId: renameId },
    ]);
    expect(
      run(["list-panes", "-s", "-t", `=${session}`, "-F", "#{@tmux_ide_pane_id}\t#{window_name}"])
        .trim()
        .split("\n")
        .find((row) => row.startsWith(`${createdPane.semanticPaneId}\t`)),
    ).toBe(`${createdPane.semanticPaneId}\tLifecycle Renamed`);
    expect(registry.qualificationSnapshot().sessions).toEqual([
      expect.objectContaining({ session, consumers: 1 }),
    ]);
    expect(binding.authoritySnapshot()).toEqual(authorityBeforeActions);
    await binding.close();
    await creation.dispose();
    executionOrder.length = 0;
    receipts.length = 0;

    const consumer = registry.connect(session, "command-center", `live:${randomUUID()}`);
    const lease = consumer.acquireController();
    const ids = Array.from({ length: 8 }, () => randomUUID());
    const intents: readonly SessionRuntimeSemanticIntent[] = [
      {
        verb: "workspace.rename",
        workspaceName,
        scope: "window",
        target: { by: "pane", semanticPaneId: "pane.editor" },
        name: "cutover-proof",
      },
      {
        verb: "workspace.pane.send",
        workspaceName,
        semanticPaneId: "pane.editor",
        text: `printf x >> '${effectFile}'`,
        submit: true,
        origin: "sdk",
      },
      {
        verb: "workspace.pane.resize",
        workspaceName,
        semanticPaneId: "pane.editor",
        axis: "cols",
        cells: 48,
      },
      {
        verb: "workspace.pane.read",
        workspaceName,
        semanticPaneId: "pane.editor",
        origin: "sdk",
      },
      {
        verb: "workspace.pane.swap",
        workspaceName,
        sourceSemanticPaneId: "pane.editor",
        targetSemanticPaneId: "pane.tests",
      },
      {
        verb: "workspace.pane.select",
        workspaceName,
        semanticPaneId: "pane.tests",
      },
      {
        verb: "workspace.pane.zoom.toggle",
        workspaceName,
        semanticPaneId: "pane.editor",
        desired: "zoomed",
      },
      {
        verb: "workspace.window.split",
        workspaceName,
        semanticPaneId: "pane.editor",
        direction: "down",
        displayTitle: "Cutover child",
      },
    ];

    try {
      const firstResults = await Promise.all(
        intents.map((intent, index) => consumer.submitIntent(lease, ids[index]!, intent)),
      );
      expect(executionOrder).toEqual(intents.map(({ verb }) => verb));
      expect(receipts).toHaveLength(intents.length * 2);
      for (const [index, intent] of intents.entries()) {
        const operationReceipts = receipts.filter(({ operationId }) => operationId === ids[index]);
        expect(operationReceipts.map(({ phase }) => phase)).toEqual(["accepted", "observed"]);
        expect(operationReceipts[1]).toMatchObject({
          operationKind: intent.verb,
          phase: "observed",
          proof: { operationKind: intent.verb },
        });
      }

      expect(run(["display-message", "-p", "-t", firstPane, "#{window_name}"]).trim()).toBe(
        "cutover-proof",
      );
      await vi.waitFor(() => expect(readFileSync(effectFile, "utf8")).toBe("x"));

      const receiptCount = receipts.length;
      const replayed = await Promise.all(
        intents.map((intent, index) => consumer.submitIntent(lease, ids[index]!, intent)),
      );
      expect(receipts).toHaveLength(receiptCount);
      expect(executionOrder).toHaveLength(intents.length);
      expect(replayed[0]).toMatchObject({ outcome: "replayed" });
      expect(replayed[1]).toMatchObject({ outcome: "replayed" });
      expect(replayed[2]).toMatchObject({ outcome: "replayed" });
      expect(replayed[3]).toBeUndefined();
      expect(replayed[4]).toMatchObject({ outcome: "replayed" });
      expect(readFileSync(effectFile, "utf8")).toBe("x");

      const createdPane = (firstResults[7] as { semanticPaneId: string }).semanticPaneId;
      const finalIds = [randomUUID(), randomUUID(), randomUUID()];
      const finalIntents: readonly SessionRuntimeSemanticIntent[] = [
        { verb: "workspace.pane.kill", workspaceName, semanticPaneId: createdPane },
        {
          verb: "workspace.window.kill",
          workspaceName,
          target: { by: "pane", semanticPaneId: "pane.aux" },
        },
        { verb: "workspace.session.kill", workspaceName },
      ];
      for (const [index, intent] of finalIntents.entries()) {
        await consumer.submitIntent(lease, finalIds[index]!, intent);
      }
      expect(executionOrder).toEqual([...intents, ...finalIntents].map(({ verb }) => verb));
      for (const [index, intent] of finalIntents.entries()) {
        const operationReceipts = receipts.filter(
          ({ operationId }) => operationId === finalIds[index],
        );
        expect(operationReceipts.map(({ phase }) => phase)).toEqual(["accepted", "observed"]);
        expect(operationReceipts[1]?.proof).toMatchObject({ operationKind: intent.verb });
      }
      expect(spawnSync(tmuxPath, ["-L", socket, "has-session", "-t", session]).status).not.toBe(0);
      const finalReceiptCount = receipts.length;
      for (const [index, intent] of finalIntents.entries()) {
        expect(await consumer.submitIntent(lease, finalIds[index]!, intent)).toMatchObject({
          outcome: "replayed",
        });
      }
      expect(receipts).toHaveLength(finalReceiptCount);
      expect(executionOrder).toHaveLength(11);
    } finally {
      await consumer.close();
      await observer.dispose();
      await registry.dispose();
      await authority.dispose();
      rmSync(effectFile, { force: true });
      rmSync(readyFile, { force: true });
    }
  }, 30_000);
});
