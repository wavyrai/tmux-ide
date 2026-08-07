import { describe, expect, it } from "vitest";
import {
  SemanticPaneCatalog,
  SemanticPaneCatalogError,
  type TrustedSemanticPaneSnapshot,
} from "../attachments/semantic-pane-catalog.ts";

const target = { workspaceName: "workspace.alpha", semanticPaneId: "pane.worker" };

function row(overrides: Partial<TrustedSemanticPaneSnapshot> = {}): TrustedSemanticPaneSnapshot {
  return {
    workspaceName: target.workspaceName,
    semanticPaneId: target.semanticPaneId,
    sessionId: "$1",
    windowId: "@2",
    runtimePaneId: "%3",
    windowPaneCount: 1,
    sessionWindowCount: 2,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("SemanticPaneCatalog", () => {
  it("resolves only semantic identity to a strict trusted runtime proof", async () => {
    const catalog = new SemanticPaneCatalog({ discover: () => [row()] });
    await expect(catalog.resolve(target)).resolves.toEqual({
      target,
      bindingGeneration: 0,
      source: {
        sessionId: "$1",
        windowId: "@2",
        runtimePaneId: "%3",
        windowStamp: null,
        windowPaneCount: 1,
        windowPaneIndex: 0,
        sessionWindowCount: 2,
      },
    });
    await expect(catalog.resolve({ ...target, runtimePaneId: "%999" } as never)).rejects.toThrow();
  });

  it("resolves a pane set from one trusted discovery snapshot", async () => {
    let discoveries = 0;
    const siblingTarget = { ...target, semanticPaneId: "pane.sibling" };
    const catalog = new SemanticPaneCatalog({
      discover: () => {
        discoveries += 1;
        return [
          row({ windowStamp: "window.shared", windowPaneCount: 2 }),
          row({
            semanticPaneId: siblingTarget.semanticPaneId,
            runtimePaneId: "%4",
            windowStamp: "window.shared",
            windowPaneCount: 2,
          }),
        ];
      },
    });

    const resolved = await catalog.resolveMany([target, siblingTarget]);
    expect(discoveries).toBe(1);
    expect(resolved.map((pane) => pane.source.windowId)).toEqual(["@2", "@2"]);
    expect(resolved.map((pane) => pane.source.runtimePaneId)).toEqual(["%3", "%4"]);
  });

  it("keeps generations stable and increments when trusted tmux identity churns", async () => {
    let rows = [row()];
    const catalog = new SemanticPaneCatalog({ discover: () => rows });
    expect((await catalog.resolve(target)).bindingGeneration).toBe(0);
    expect((await catalog.resolve(target)).bindingGeneration).toBe(0);

    rows = [row({ runtimePaneId: "%8" })];
    expect((await catalog.resolve(target)).bindingGeneration).toBe(1);
    expect((await catalog.resolve(target)).bindingGeneration).toBe(1);

    rows = [row({ sessionId: "$9", windowId: "@10", runtimePaneId: "%11" })];
    expect((await catalog.resolve(target)).bindingGeneration).toBe(2);
  });

  it("rejects duplicate semantic stamps but scopes uniqueness per workspace", async () => {
    const duplicate = new SemanticPaneCatalog({
      discover: () => [row(), row({ windowId: "@8", runtimePaneId: "%9" })],
    });
    await expectCode(duplicate.resolve(target), "duplicate-semantic-stamp");

    const scoped = new SemanticPaneCatalog({
      discover: () => [
        row(),
        row({
          workspaceName: "workspace.beta",
          sessionId: "$4",
          windowId: "@5",
          runtimePaneId: "%6",
        }),
      ],
    });
    await expect(scoped.resolve(target)).resolves.toMatchObject({ bindingGeneration: 0 });
  });

  it("fails closed when any semantic/runtime binding in the workspace is not bijective", async () => {
    const unrelatedDuplicate = new SemanticPaneCatalog({
      discover: () => [
        row(),
        row({ semanticPaneId: "pane.other", windowId: "@8", runtimePaneId: "%9" }),
        row({ semanticPaneId: "pane.other", windowId: "@10", runtimePaneId: "%11" }),
      ],
    });
    await expectCode(unrelatedDuplicate.resolve(target), "duplicate-semantic-stamp");

    const duplicateRuntime = new SemanticPaneCatalog({
      discover: () => [
        row(),
        row({ semanticPaneId: "pane.other", windowId: "@2", runtimePaneId: "%3" }),
      ],
    });
    await expectCode(duplicateRuntime.resolve(target), "duplicate-runtime-pane-binding");
  });

  it("rejects a global runtime pane alias across workspaces and linked sessions", async () => {
    const aliasedRuntime = new SemanticPaneCatalog({
      discover: () => [
        row(),
        row({
          workspaceName: "workspace.beta",
          semanticPaneId: "pane.other",
          sessionId: "$9",
        }),
      ],
    });
    await expectCode(aliasedRuntime.resolve(target), "duplicate-runtime-pane-binding");
  });

  it("rejects missing stamps instead of guessing from runtime pane ids", async () => {
    const catalog = new SemanticPaneCatalog({
      discover: () => [row({ semanticPaneId: null })],
    });
    await expectCode(catalog.resolve(target), "missing-semantic-stamp");
  });

  it("rejects the display-only fallback namespace in targets and trusted stamps", async () => {
    const reserved = "terminal.discovered.user-authored";
    const catalog = new SemanticPaneCatalog({ discover: () => [row()] });
    await expect(catalog.resolve({ ...target, semanticPaneId: reserved })).rejects.toThrow(
      /reserved discovered-terminal identity/u,
    );

    const poisoned = new SemanticPaneCatalog({
      discover: () => [row({ semanticPaneId: reserved })],
    });
    await expectCode(poisoned.resolve(target), "invalid-runtime-proof");
  });

  it("shares the portable workspace-id grammar across targets and trusted stamps", async () => {
    for (const semanticPaneId of [
      "pane:colon",
      "constructor",
      "__proto__",
      ".leading-dot",
      `pane.${"x".repeat(124)}`,
    ]) {
      const catalog = new SemanticPaneCatalog({ discover: () => [row()] });
      await expect(catalog.resolve({ ...target, semanticPaneId })).rejects.toThrow();

      const poisoned = new SemanticPaneCatalog({
        discover: () => [row({ semanticPaneId })],
      });
      await expectCode(poisoned.resolve(target), "invalid-runtime-proof");
    }
  });

  it("fails closed when an unrelated authoritative discovery row is unstamped", async () => {
    const catalog = new SemanticPaneCatalog({
      discover: () => [
        row(),
        row({
          workspaceName: "workspace.unrelated",
          semanticPaneId: null,
          sessionId: "$8",
          windowId: "@9",
          runtimePaneId: "%10",
        }),
      ],
    });
    await expectCode(catalog.resolve(target), "missing-semantic-stamp");
  });

  it("distinguishes absent workspaces and semantic panes", async () => {
    const catalog = new SemanticPaneCatalog({ discover: () => [row()] });
    await expectCode(
      catalog.resolve({ workspaceName: "workspace.missing", semanticPaneId: "pane.worker" }),
      "workspace-not-found",
    );
    await expectCode(
      catalog.resolve({ workspaceName: target.workspaceName, semanticPaneId: "pane.missing" }),
      "pane-not-found",
    );
  });

  it("proves a whole multi-pane window by its durable window stamp", async () => {
    const windowRows = (paneCount: number): TrustedSemanticPaneSnapshot[] =>
      Array.from({ length: paneCount }, (_unused, index) =>
        row({
          semanticPaneId: index === 0 ? target.semanticPaneId : `pane.worker-${index}`,
          runtimePaneId: `%${10 + index}`,
          windowStamp: "window.workspace.alpha",
          windowPaneCount: paneCount,
        }),
      );

    const nine = new SemanticPaneCatalog({ discover: () => windowRows(9) });
    await expect(nine.resolve(target)).resolves.toMatchObject({
      bindingGeneration: 0,
      source: {
        windowId: "@2",
        runtimePaneId: "%10",
        windowStamp: "window.workspace.alpha",
        windowPaneCount: 9,
        windowPaneIndex: 0,
      },
    });

    const two = new SemanticPaneCatalog({ discover: () => windowRows(2) });
    await expect(two.resolve(target)).resolves.toMatchObject({
      source: { windowStamp: "window.workspace.alpha", windowPaneCount: 2, windowPaneIndex: 0 },
    });

    const stampedSingle = new SemanticPaneCatalog({
      discover: () => [row({ windowStamp: "window.workspace.alpha" })],
    });
    await expect(stampedSingle.resolve(target)).resolves.toMatchObject({
      source: { windowStamp: "window.workspace.alpha", windowPaneCount: 1, windowPaneIndex: 0 },
    });
  });

  it("fails closed on missing, inconsistent, or duplicated window stamps", async () => {
    const unstampedMulti = new SemanticPaneCatalog({
      discover: () => [
        row({ windowPaneCount: 2 }),
        row({ semanticPaneId: "pane.worker-1", runtimePaneId: "%4", windowPaneCount: 2 }),
      ],
    });
    await expectCode(unstampedMulti.resolve(target), "missing-window-stamp");

    const mixedMulti = new SemanticPaneCatalog({
      discover: () => [
        row({ windowStamp: "window.workspace.alpha", windowPaneCount: 2 }),
        row({ semanticPaneId: "pane.worker-1", runtimePaneId: "%4", windowPaneCount: 2 }),
      ],
    });
    await expectCode(mixedMulti.resolve(target), "window-stamp-inconsistent");

    const disagreeing = new SemanticPaneCatalog({
      discover: () => [
        row({ windowStamp: "window.workspace.alpha", windowPaneCount: 2 }),
        row({
          semanticPaneId: "pane.worker-1",
          runtimePaneId: "%4",
          windowStamp: "window.workspace.beta",
          windowPaneCount: 2,
        }),
      ],
    });
    await expectCode(disagreeing.resolve(target), "window-stamp-inconsistent");

    const aliasedWindows = new SemanticPaneCatalog({
      discover: () => [
        row({ windowStamp: "window.workspace.alpha" }),
        row({
          workspaceName: "workspace.beta",
          semanticPaneId: "pane.worker",
          sessionId: "$4",
          windowId: "@5",
          runtimePaneId: "%6",
          windowStamp: "window.workspace.alpha",
        }),
      ],
    });
    await expectCode(aliasedWindows.resolve(target), "duplicate-window-stamp");
  });

  it("rejects a reserved or malformed window stamp as an invalid runtime proof", async () => {
    for (const windowStamp of ["terminal.discovered.window", "window:colon", "__proto__"]) {
      const poisoned = new SemanticPaneCatalog({ discover: () => [row({ windowStamp })] });
      await expectCode(poisoned.resolve(target), "invalid-runtime-proof");
    }
  });

  it("rejects malformed trusted runtime proof", async () => {
    const malformed = new SemanticPaneCatalog({
      discover: () => [{ ...row(), runtimePaneId: "pane.worker" } as never],
    });
    await expectCode(malformed.resolve(target), "invalid-runtime-proof");

    const oversized = new SemanticPaneCatalog({
      discover: () => [row({ sessionId: `$${"1".repeat(33)}` })],
    });
    await expectCode(oversized.resolve(target), "invalid-runtime-proof");
  });

  it("wraps discovery failures without echoing tmux or secret data", async () => {
    const catalog = new SemanticPaneCatalog({
      discover: () => {
        throw new Error("secret runtime diagnostic %7");
      },
    });
    try {
      await catalog.resolve(target);
      throw new Error("expected catalog failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticPaneCatalogError);
      expect(error).toMatchObject({ code: "discovery-failed" });
      expect((error as Error).message).not.toContain("%7");
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("secret runtime diagnostic");
    }
  });
});
