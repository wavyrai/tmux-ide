import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_WINDOW_MAX_WINDOWS, AppWindowDocumentV1SchemaZ } from "@tmux-ide/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { ProjectResolution } from "../project-resolver.ts";
import {
  createProjectRuntimeRepository,
  openProjectRuntimeRepository,
} from "../project-runtime-repository.ts";
import { APP_WINDOW_DOCUMENT_PATH, writeAppWindowDocument } from "../app-window-repository.ts";
import {
  initialApplicationShellAppWindows,
  loadApplicationShellAppWindows,
  reconcileApplicationShellAppWindowRepository,
  reconcileApplicationShellAppWindows,
} from "../application-shell-app-windows.ts";

const NOW = "2026-07-22T10:00:00.000Z";
const LATER = "2026-07-22T10:01:00.000Z";
const LAST = "2026-07-22T10:02:00.000Z";
const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function resolution(projectRoot: string): ProjectResolution {
  return {
    inputDir: projectRoot,
    projectRoot,
    identityKey: `git-${"a".repeat(64)}`,
    identitySource: "git-common-dir",
    identityAnchor: join(projectRoot, ".git"),
    config: { kind: "none", path: null, explicit: false },
    workspaceConfigPath: null,
    legacyConfigPath: null,
    hasLegacyConfigAtInput: false,
  };
}

function repositoryPair() {
  const home = temporaryRoot("application-shell-app-window-home-");
  const project = temporaryRoot("application-shell-app-window-project-");
  const projectResolution = resolution(project);
  return {
    home,
    projectResolution,
    first: createProjectRuntimeRepository(projectResolution, { home }),
    second: createProjectRuntimeRepository(projectResolution, { home }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("initialApplicationShellAppWindows", () => {
  it("creates one deterministic visible dock leaf per terminal and preserves semantic focus", () => {
    const sourceIds = Array.from({ length: 17 }, (_, index) => `terminal.agent.${index}`);
    const first = initialApplicationShellAppWindows(sourceIds, sourceIds[11]!, NOW);
    const second = initialApplicationShellAppWindows(sourceIds, sourceIds[11]!, NOW);

    expect(first).toEqual(second);
    expect(AppWindowDocumentV1SchemaZ.parse(first)).toEqual(first);
    expect(Object.values(first.windows)).toHaveLength(17);
    expect(Object.values(first.windows).map(({ source }) => source)).toEqual(
      [...sourceIds]
        .sort((left, right) => left.localeCompare(right))
        .map((terminalSourceId) => ({ kind: "terminal", terminalSourceId })),
    );
    expect(first.windows[first.focusedWindowId!]?.source).toEqual({
      kind: "terminal",
      terminalSourceId: sourceIds[11],
    });
    expect(first.dockRoot).toMatchObject({ type: "split", axis: "vertical" });
  });

  it("deduplicates discovery and keeps an empty first-run scene valid", () => {
    const duplicate = initialApplicationShellAppWindows(
      ["terminal.lead", "terminal.lead"],
      "terminal.lead",
      NOW,
    );
    expect(Object.values(duplicate.windows)).toHaveLength(1);
    expect(duplicate.dockRoot).toMatchObject({ type: "stack" });

    const empty = initialApplicationShellAppWindows([], null, NOW);
    expect(empty.dockRoot).toBeNull();
    expect(empty.focusedWindowId).toBeNull();
    expect(AppWindowDocumentV1SchemaZ.safeParse(empty).success).toBe(true);
  });

  it("deterministically admits no more than the contract maximum", () => {
    const sourceIds = Array.from(
      { length: APP_WINDOW_MAX_WINDOWS + 17 },
      (_, index) => `terminal.${String(index).padStart(3, "0")}`,
    ).reverse();
    const first = initialApplicationShellAppWindows(sourceIds, sourceIds[0]!, NOW);
    const second = initialApplicationShellAppWindows([...sourceIds].reverse(), sourceIds[0]!, NOW);

    expect(Object.keys(first.windows)).toHaveLength(APP_WINDOW_MAX_WINDOWS);
    expect(first).toEqual(second);
    expect(AppWindowDocumentV1SchemaZ.safeParse(first).success).toBe(true);
    expect(Object.values(first.windows).map(({ source }) => source)).toEqual(
      [...sourceIds]
        .sort((left, right) => left.localeCompare(right))
        .slice(0, APP_WINDOW_MAX_WINDOWS)
        .map((terminalSourceId) => ({ kind: "terminal", terminalSourceId })),
    );
  });

  it("preserves existing placement while admitting a post-first-run terminal", () => {
    const initial = initialApplicationShellAppWindows(["terminal.lead"], "terminal.lead", NOW);
    const lead = Object.values(initial.windows)[0]!;
    const reconciled = reconcileApplicationShellAppWindows(
      initial,
      ["terminal.worker", "terminal.lead"],
      "terminal.worker",
      LATER,
    );
    const worker = Object.values(reconciled.windows).find(
      ({ source }) => source.kind === "terminal" && source.terminalSourceId === "terminal.worker",
    )!;

    expect(reconciled.revision).toBe(initial.revision + 1);
    expect(reconciled.windows[lead.id]?.placement).toEqual(lead.placement);
    expect(worker.placement.mode).toBe("floating");
    expect(reconciled.floatingOrder.at(-1)).toBe(worker.id);
    expect(reconciled.focusedWindowId).toBe(worker.id);
    expect(AppWindowDocumentV1SchemaZ.safeParse(reconciled).success).toBe(true);
  });

  it("preserves document identity when the terminal inventory is already reconciled", () => {
    const initial = initialApplicationShellAppWindows(["terminal.lead"], "terminal.lead", NOW);
    const reconciled = reconcileApplicationShellAppWindows(
      initial,
      ["terminal.lead", "terminal.lead"],
      "terminal.lead",
      LATER,
    );

    expect(reconciled).toBe(initial);
    expect(reconciled.revision).toBe(0);
    expect(reconciled.updatedAt).toBe(NOW);
  });

  it("persists newly discovered terminals after first run through revision CAS", () => {
    const { first, second } = repositoryPair();
    const created = reconcileApplicationShellAppWindowRepository(
      first,
      ["terminal.lead"],
      "terminal.lead",
      NOW,
    );
    const reconciled = reconcileApplicationShellAppWindowRepository(
      second,
      ["terminal.lead", "terminal.worker"],
      "terminal.worker",
      LATER,
    );

    expect(created.revision).toBe(0);
    expect(reconciled.revision).toBe(1);
    expect(Object.values(reconciled.windows).map(({ source }) => source)).toContainEqual({
      kind: "terminal",
      terminalSourceId: "terminal.worker",
    });
    expect(first.readRequiredDocument(APP_WINDOW_DOCUMENT_PATH).revision).toBe(2);
  });

  it("initializes a config-free project once and serves repeat V3 loads without rewriting", async () => {
    const home = temporaryRoot("application-shell-config-free-home-");
    const project = temporaryRoot("application-shell-config-free-project-");
    const previousHome = process.env.TMUX_IDE_HOME;
    process.env.TMUX_IDE_HOME = home;
    try {
      const created = await loadApplicationShellAppWindows(
        project,
        ["pane.workspace.lead"],
        "pane.workspace.lead",
      );
      const runtime = await openProjectRuntimeRepository(project);
      const firstEnvelope = runtime.readRequiredDocument(APP_WINDOW_DOCUMENT_PATH);

      const repeated = await loadApplicationShellAppWindows(
        project,
        ["pane.workspace.lead"],
        "pane.workspace.lead",
      );
      const secondEnvelope = runtime.readRequiredDocument(APP_WINDOW_DOCUMENT_PATH);

      expect(Object.values(created.windows)).toHaveLength(1);
      expect(created.focusedWindowId).not.toBeNull();
      expect(repeated).toEqual(created);
      expect(firstEnvelope.revision).toBe(1);
      expect(secondEnvelope.revision).toBe(firstEnvelope.revision);
      expect(secondEnvelope.payload).toEqual(firstEnvelope.payload);
    } finally {
      if (previousHome === undefined) delete process.env.TMUX_IDE_HOME;
      else process.env.TMUX_IDE_HOME = previousHome;
    }
  });

  it("retries a stale reconciliation without losing an external terminal", () => {
    const { home, projectResolution, first, second } = repositoryPair();
    const created = reconcileApplicationShellAppWindowRepository(
      first,
      ["terminal.lead"],
      "terminal.lead",
      NOW,
    );
    const target = join(first.runtimeRoot, APP_WINDOW_DOCUMENT_PATH);
    let injected = false;
    const racing = createProjectRuntimeRepository(projectResolution, {
      home,
      io: {
        readBytes: (path) => {
          const bytes = readFileSync(path);
          if (path === target && !injected) {
            injected = true;
            writeAppWindowDocument(
              second,
              1,
              reconcileApplicationShellAppWindows(
                created,
                ["terminal.lead", "terminal.external"],
                "terminal.external",
                LATER,
              ),
            );
          }
          return bytes;
        },
      },
    });

    const reconciled = reconcileApplicationShellAppWindowRepository(
      racing,
      ["terminal.lead", "terminal.local"],
      "terminal.local",
      LAST,
    );
    const sourceIds = Object.values(reconciled.windows).flatMap(({ source }) =>
      source.kind === "terminal" ? [source.terminalSourceId] : [],
    );

    expect(sourceIds.sort()).toEqual(["terminal.external", "terminal.lead", "terminal.local"]);
    expect(reconciled.revision).toBe(2);
    expect(first.readRequiredDocument(APP_WINDOW_DOCUMENT_PATH).revision).toBe(3);
  });
});
