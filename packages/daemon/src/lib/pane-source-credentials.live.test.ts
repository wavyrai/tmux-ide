import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { InteractionReceipt, SessionRuntimeSemanticIntent } from "@tmux-ide/contracts";
import { SessionRuntimeRegistry } from "../terminal/session-runtime/registry.ts";
import { createSessionRuntimeMultiplexerBackend } from "../terminal/session-runtime/multiplexer-backend.ts";
import {
  PANE_SOURCE_CREDENTIAL_OPTION,
  PaneSourceCredentialAuthority,
} from "./pane-source-credentials.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux).sequential("pane source credentials, live tmux", () => {
  it("reconciles every window and rotates only a pane whose installed option changed", () => {
    const socketName = `zz-m56-pane-windows-${process.pid}-${randomUUID().slice(0, 8)}`;
    const session = `m56-pane-windows-${randomUUID().slice(0, 8)}`;
    const run = (args: readonly string[]): string => {
      const result = spawnSync("tmux", ["-L", socketName, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || `tmux ${args[0]} failed`);
      return result.stdout;
    };
    const cleanup = () => {
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
    };
    cleanup();
    try {
      const firstPane = run([
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        session,
        "-n",
        "first",
      ]).trim();
      const secondPane = run([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        `=${session}`,
        "-n",
        "second",
      ]).trim();
      run(["set-option", "-p", "-t", firstPane, "@tmux_ide_pane_id", "pane.first"]);
      run(["set-option", "-p", "-t", secondPane, "@tmux_ide_pane_id", "pane.second"]);

      const authority = new PaneSourceCredentialAuthority({ run });
      authority.rotateSession(session);
      const credential = (paneId: string) =>
        run(["display-message", "-p", "-t", paneId, `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`]).trim();
      const firstToken = credential(firstPane);
      const secondToken = credential(secondPane);
      expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(authority.resolve(firstToken, session, "pane.first")).toBe("pane.first");
      expect(authority.resolve(secondToken, session, "pane.second")).toBe("pane.second");

      run([
        "set-option",
        "-p",
        "-t",
        secondPane,
        PANE_SOURCE_CREDENTIAL_OPTION,
        "same-user-option-churn",
      ]);
      authority.reconcileSession(session);
      expect(credential(firstPane)).toBe(firstToken);
      const rotatedSecondToken = credential(secondPane);
      expect(rotatedSecondToken).not.toBe(secondToken);
      expect(authority.resolve(firstToken, session, "pane.first")).toBe("pane.first");
      expect(authority.resolve(secondToken, session, "pane.second")).toBeNull();
      expect(authority.resolve(rotatedSecondToken, session, "pane.second")).toBe("pane.second");
      authority.dispose();
    } finally {
      cleanup();
    }
  });

  it("attributes a headless CLI send and rejects its credential after daemon restart", async () => {
    const socketName = `zz-m56-pane-source-${process.pid}-${randomUUID().slice(0, 8)}`;
    const session = `m56-pane-source-${randomUUID().slice(0, 8)}`;
    const run = (args: readonly string[]): string => {
      const result = spawnSync("tmux", ["-L", socketName, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || `tmux ${args[0]} failed`);
      return result.stdout;
    };
    const cleanup = () => {
      spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
    };
    cleanup();
    run(["new-session", "-d", "-s", session, "-n", "work"]);
    run(["split-window", "-d", "-t", `${session}:0`]);
    const [sourcePane, targetPane] = run(["list-panes", "-t", session, "-F", "#{pane_id}"])
      .trim()
      .split("\n");
    if (!sourcePane || !targetPane) throw new Error("tmux did not create two panes");
    run(["set-option", "-p", "-t", sourcePane, "@tmux_ide_pane_id", "pane.editor"]);
    run(["set-option", "-p", "-t", targetPane, "@tmux_ide_pane_id", "pane.tests"]);

    let authority = new PaneSourceCredentialAuthority({ run });
    const receipts: InteractionReceipt[] = [];
    let sequence = 0;
    let registry!: SessionRuntimeRegistry;
    registry = new SessionRuntimeRegistry({
      generation: randomUUID(),
      semanticMutations: {
        resolveSession: (workspaceName) => (workspaceName === "alpha" ? session : null),
        execute: async (operationId, intent) => {
          if (intent.verb !== "workspace.pane.send") throw new Error("unexpected read");
          run(["send-keys", "-t", targetPane, "-l", "--", intent.text]);
          if (intent.submit) run(["send-keys", "-t", targetPane, "Enter"]);
          queueMicrotask(() =>
            registry.observeTmuxInteraction({
              operationId,
              workspaceName: intent.workspaceName,
              semanticPaneId: intent.semanticPaneId,
              operationKind: "workspace.pane.send",
            }),
          );
          return { outcome: "applied" } as never;
        },
        publishReceipt: (receipt) => {
          const published = {
            type: "interaction.receipt",
            sequence: (sequence += 1),
            ...receipt,
          } as InteractionReceipt;
          receipts.push(published);
          return published;
        },
      },
    });
    const backend = createSessionRuntimeMultiplexerBackend({
      registry,
      resolveSession: (workspaceName) => (workspaceName === "alpha" ? session : null),
      resolvePaneSourceCredential: (credential, resolvedSession, claimedSource) =>
        authority.resolve(credential, resolvedSession, claimedSource),
    });
    const sendIntent = (text: string): SessionRuntimeSemanticIntent => ({
      verb: "workspace.pane.send",
      workspaceName: "alpha",
      semanticPaneId: "pane.tests",
      sourceSemanticPaneId: "pane.editor",
      text,
      submit: true,
      origin: "cli",
    });

    try {
      authority.rotateSession(session);
      const oldCredential = run([
        "display-message",
        "-p",
        "-t",
        sourcePane,
        `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
      ]).trim();
      const marker = `M56_AUTH_${randomUUID().slice(0, 8)}`;
      await backend.mutate(
        {
          operationId: randomUUID(),
          expectedDaemonInstanceId: registry.generation,
          intent: sendIntent(`printf '${marker}\\n'`),
        },
        undefined,
        oldCredential,
      );
      await vi.waitFor(() => {
        expect(run(["capture-pane", "-p", "-t", targetPane])).toContain(marker);
      });
      expect(receipts.slice(-2)).toMatchObject([
        { phase: "accepted", sourceSemanticPaneId: null },
        { phase: "observed", sourceSemanticPaneId: "pane.editor" },
      ]);

      // A daemon generation restart replaces the in-memory authority and
      // rotates pane options without owning or restarting the tmux server.
      authority.dispose();
      authority = new PaneSourceCredentialAuthority({ run });
      authority.rotateSession(session);
      expect(run(["has-session", "-t", session])).toBe("");
      expect(
        run([
          "display-message",
          "-p",
          "-t",
          sourcePane,
          `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
        ]).trim(),
      ).not.toBe(oldCredential);
      await expect(
        backend.mutate(
          {
            operationId: randomUUID(),
            expectedDaemonInstanceId: registry.generation,
            intent: sendIntent("printf 'STALE_SHOULD_NOT_RUN\\n'"),
          },
          undefined,
          oldCredential,
        ),
      ).rejects.toThrow("invalid or stale");
      expect(run(["capture-pane", "-p", "-t", targetPane])).not.toContain("STALE_SHOULD_NOT_RUN");
    } finally {
      authority.dispose();
      await registry.dispose();
      cleanup();
    }
  }, 15_000);
});
