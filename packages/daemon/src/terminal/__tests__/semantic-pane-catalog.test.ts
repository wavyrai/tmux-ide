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
        paneCount: 1,
        sessionWindowCount: 2,
      },
    });
    await expect(catalog.resolve({ ...target, runtimePaneId: "%999" } as never)).rejects.toThrow();
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

  it("rejects split windows and malformed trusted runtime proof", async () => {
    const split = new SemanticPaneCatalog({ discover: () => [row({ windowPaneCount: 2 })] });
    await expectCode(split.resolve(target), "not-single-pane-window");

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
