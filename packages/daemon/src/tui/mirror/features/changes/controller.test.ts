import { describe, expect, it, vi } from "vitest";

import type { WorkspaceChangesCatalogEnvelopeV1 } from "@tmux-ide/contracts";

import { createChangesFeatureController } from "./controller.ts";
import type { ChangesFeatureHost, ChangesHoverTarget } from "./contract.ts";

type GitCall = {
  directory: string;
  args: readonly string[];
  callback: (stdout: string) => void;
};

interface TestChangeEntry {
  group: "staged" | "unstaged" | "untracked";
  status: "modified" | "added" | "untracked";
  relativePath: string;
  additions: number | null;
  deletions: number | null;
}

function ready(entries: readonly TestChangeEntry[]): WorkspaceChangesCatalogEnvelopeV1 {
  return {
    resource: {
      workspaceName: "alpha",
      status: "ready",
      entries,
      observedAt: "2026-08-12T00:00:00.000Z",
    },
  } as WorkspaceChangesCatalogEnvelopeV1;
}

function harness(options: { width?: number; height?: number } = {}) {
  const git: GitCall[] = [];
  const notes: string[] = [];
  const opened: Array<{ path: string; line?: number }> = [];
  let refreshes = 0;
  let hover: ChangesHoverTarget | null = null;
  const host: ChangesFeatureHost = {
    width: () => options.width ?? 120,
    height: () => options.height ?? 28,
    hover: () => hover,
    refreshResource: () => {
      refreshes += 1;
    },
    setStatusNote: (message) => notes.push(message),
    openEditor: (path, line) => opened.push({ path, ...(line === undefined ? {} : { line }) }),
    runGit: (directory, args, callback) => git.push({ directory, args, callback }),
    readFile: vi.fn(() => Buffer.from("first\nsecond\n")),
  };
  const session = createChangesFeatureController(host, "/repo");
  return {
    session,
    git,
    notes,
    opened,
    refreshes: () => refreshes,
    setHover: (next: ChangesHoverTarget | null) => {
      hover = next;
    },
  };
}

const entries = [
  {
    group: "staged" as const,
    status: "modified" as const,
    relativePath: "src/a.ts",
    additions: 2,
    deletions: 1,
  },
  {
    group: "unstaged" as const,
    status: "modified" as const,
    relativePath: "src/b.ts",
    additions: 4,
    deletions: 0,
  },
  {
    group: "untracked" as const,
    status: "untracked" as const,
    relativePath: "notes.txt",
    additions: 2,
    deletions: 0,
  },
];

describe("deferred Changes controller", () => {
  it("projects catalogs, restores selection, and opens the selected hunk in Files", () => {
    const test = harness();
    test.session.restoreSelectedPath("src/b.ts");
    test.session.applyCatalog(ready(entries));
    expect(test.session.selectedPath()).toBe("src/b.ts");
    expect(test.git).toHaveLength(1);
    expect(test.git[0]!.args).toEqual(["diff", "--no-color", "--", "src/b.ts"]);

    test.git[0]!.callback("@@ -4,1 +7,2 @@\n-old\n+new\n");
    expect(test.session.projection().totals).toBe("3 files · +8 -1");
    expect(
      test.session.handleKey({ name: "e", ctrl: true, meta: false, shift: false }, "surface"),
    ).toBe(true);
    expect(test.opened).toEqual([{ path: "/repo/src/b.ts", line: 6 }]);
    test.session.dispose();
  });

  it("fences selected reads across newer selection, workspace reset, and disposal", () => {
    const test = harness();
    test.session.applyCatalog(ready(entries.slice(0, 2)));
    expect(test.git).toHaveLength(1);
    test.session.handleKey({ name: "down", ctrl: false, meta: false, shift: false }, "surface");
    expect(test.git).toHaveLength(2);

    test.git[1]!.callback("+new selection\n");
    test.git[0]!.callback("+stale selection\n");
    expect(test.session.projection().diffLines.map((line) => line.text)).toEqual([
      "+new selection",
    ]);

    test.session.prepare("/other");
    expect(test.refreshes()).toBe(1);
    test.git[1]!.callback("+stale workspace\n");
    expect(test.session.projection().diffLines).toEqual([]);

    test.session.applyCatalog(ready(entries.slice(0, 1)));
    const last = test.git.at(-1)!;
    test.session.dispose();
    last.callback("+late after dispose\n");
    expect(test.session.projection()).toBeDefined();
  });

  it("keeps mutations demand-driven and follows a file into its new group", () => {
    const test = harness();
    test.session.applyCatalog(ready(entries.slice(1, 2)));
    test.git[0]!.callback("+body\n");
    test.session.handleKey({ name: "s", ctrl: false, meta: false, shift: false }, "surface");
    expect(test.git[1]!.args).toEqual(["add", "--", "src/b.ts"]);
    test.git[1]!.callback("");
    expect(test.notes).toEqual(["staged src/b.ts"]);
    expect(test.refreshes()).toBe(1);

    test.session.applyCatalog(ready([{ ...entries[1]!, group: "staged", status: "modified" }]));
    expect(test.session.selectedPath()).toBe("src/b.ts");
    expect(test.git.at(-1)!.args).toEqual(["diff", "--no-color", "--cached", "--", "src/b.ts"]);
    test.session.dispose();
  });

  it("drops a mutation completion after the controller is retired", () => {
    const test = harness();
    test.session.applyCatalog(ready(entries.slice(1, 2)));
    test.git[0]!.callback("+body\n");
    test.session.handleKey({ name: "s", ctrl: false, meta: false, shift: false }, "surface");
    const mutation = test.git[1]!;

    test.session.dispose();
    test.session.dispose();
    mutation.callback("");

    expect(test.notes).toEqual([]);
    expect(test.refreshes()).toBe(0);
  });

  it("owns filter, hover, pointer, context, and scrollbar semantics", () => {
    const test = harness({ width: 100, height: 8 });
    test.session.applyCatalog(ready(entries));
    test.git[0]!.callback(Array.from({ length: 20 }, (_, index) => `+line ${index}`).join("\n"));

    test.session.handleKey({ name: "/", ctrl: false, meta: false, shift: false }, "surface");
    test.session.handleKey({ name: "b", ctrl: false, meta: false, shift: false }, "filter");
    expect(test.session.filterOpen()).toBe(true);
    expect(test.session.selectedPath()).toBe("src/b.ts");
    test.session.handleKey({ name: "escape", ctrl: false, meta: false, shift: false }, "filter");

    const projection = test.session.projection();
    const file = projection.listRows.find((row) => row.kind === "file")!;
    expect(test.session.hoverTargetAt(file.x + 1, file.y)).toEqual({
      kind: "list-row",
      index: file.rowIndex,
    });
    expect(test.session.contextTargetAt(file.x + 1, file.y)).toEqual({
      title: file.entry.path.split("/").at(-1),
      path: `/repo/${file.entry.path}`,
    });

    const before = test.session.scrollState().top;
    test.session.handlePointer({
      type: "scroll",
      x: projection.diff.x,
      y: projection.diff.y,
      direction: "down",
      scrollStep: 3,
    });
    expect(test.session.scrollState().top).toBeGreaterThan(before);
    test.session.setScrollTop(999);
    expect(test.session.scrollState().top).toBeLessThan(999);
    test.session.dispose();
  });

  it("renders untracked content without launching Git", () => {
    const test = harness();
    test.session.applyCatalog(ready(entries.slice(2)));
    expect(test.git).toHaveLength(0);
    expect(test.session.projection().diffLines.map((line) => line.text)).toEqual([
      "+first",
      "+second",
    ]);
    test.session.dispose();
  });
});
