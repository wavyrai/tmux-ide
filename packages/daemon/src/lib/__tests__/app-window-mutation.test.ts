import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProjectRuntimeRepository } from "../project-runtime-repository.ts";
import { writeAppWindowDocument } from "../app-window-repository.ts";
import { AppWindowMutationAuthority, AppWindowMutationError } from "../app-window-mutation.ts";

const DAEMON = "00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "app-window-mutation-home-"));
  const project = mkdtempSync(join(tmpdir(), "app-window-mutation-project-"));
  roots.push(home, project);
  const runtime = createProjectRuntimeRepository(
    {
      inputDir: project,
      projectRoot: project,
      identityKey: `git-${"a".repeat(64)}`,
      identitySource: "git-common-dir",
      identityAnchor: join(project, ".git"),
      config: { kind: "none", path: null, explicit: false },
      workspaceConfigPath: null,
      legacyConfigPath: null,
      hasLegacyConfigAtInput: false,
    },
    { home },
  );
  writeAppWindowDocument(runtime, null, {
    version: 1,
    revision: 0,
    updatedAt: "2026-07-22T10:00:00.000Z",
    windows: {
      terminal: {
        id: "terminal",
        source: { kind: "terminal", terminalSourceId: "pane.shell" },
        title: "Shell",
        placement: {
          mode: "floating",
          docked: null,
          floating: { x: 20, y: 30, width: 640, height: 400 },
        },
      },
    },
    dockRoot: null,
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: ["terminal"],
    focusedWindowId: "terminal",
    activeLayoutId: null,
    layouts: {},
  });
  return {
    runtime,
    authority: new AppWindowMutationAuthority({
      daemonInstanceId: DAEMON,
      registry: { get: (name) => (name === "alpha" ? { projectDir: project } : null) },
      openRuntime: async () => runtime,
      maxOperations: 2,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AppWindowMutationAuthority", () => {
  it("persists semantic geometry, replays an operation, rejects conflicts, and evicts settled history", async () => {
    const { authority } = fixture();
    const request = {
      operationId: "00000000-0000-4000-8000-000000000010",
      expectedDaemonInstanceId: DAEMON,
      intent: {
        workspaceName: "alpha",
        expectedDocumentRevision: 0,
        command: { type: "window.move" as const, windowId: "terminal", x: 80, y: 90 },
      },
    };
    const applied = await authority.mutate(request);
    expect(applied).toMatchObject({ outcome: "applied", documentRevision: 1 });
    await expect(authority.mutate(request)).resolves.toMatchObject({ outcome: "replayed" });
    await expect(
      authority.mutate({
        ...request,
        intent: { ...request.intent, command: { ...request.intent.command, x: 100 } },
      }),
    ).rejects.toMatchObject({ code: "operation_conflict" });

    for (let index = 0; index < 3; index += 1) {
      await authority.mutate({
        operationId: `00000000-0000-4000-8000-00000000002${index}`,
        expectedDaemonInstanceId: DAEMON,
        intent: {
          workspaceName: "alpha",
          expectedDocumentRevision: index + 1,
          command: { type: "window.move", windowId: "terminal", x: 81 + index, y: 90 },
        },
      });
    }
  });

  it("rejects stale revisions and daemon generations without consuming retry ids", async () => {
    const { authority } = fixture();
    const base = {
      operationId: "00000000-0000-4000-8000-000000000030",
      expectedDaemonInstanceId: DAEMON,
      intent: {
        workspaceName: "alpha",
        expectedDocumentRevision: 99,
        command: { type: "window.focus" as const, windowId: null },
      },
    };
    await expect(authority.mutate(base)).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      authority.mutate({ ...base, intent: { ...base.intent, expectedDocumentRevision: 0 } }),
    ).resolves.toMatchObject({ outcome: "applied", documentRevision: 1 });
    await expect(
      authority.mutate({
        ...base,
        operationId: "00000000-0000-4000-8000-000000000031",
        expectedDaemonInstanceId: "00000000-0000-4000-8000-000000000099",
      }),
    ).rejects.toBeInstanceOf(AppWindowMutationError);
  });
});
