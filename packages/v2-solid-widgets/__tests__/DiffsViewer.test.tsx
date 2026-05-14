import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { DiffsViewerView } from "../src/widgets/DiffsViewer";
import type { DiffData, DiffFileEntry } from "../src/api";
import type { DiffsViewerMountOptions } from "../src/types";

const originalFetch = globalThis.fetch;

interface MockRoutes {
  /** Project-wide /diff response. */
  summary: DiffData | null;
  /** Map of file path -> per-file patch string. */
  filePatches?: Record<string, string>;
}

function installFetchMock(routes: MockRoutes) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // /api/project/:name/diff/:file
    const fileMatch = url.match(/\/api\/project\/[^/]+\/diff\/(.+)$/);
    if (fileMatch) {
      const file = decodeURIComponent(fileMatch[1]!);
      const diff = routes.filePatches?.[file] ?? "";
      return Promise.resolve(
        new Response(JSON.stringify({ diff }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    // /api/project/:name/diff
    if (/\/api\/project\/[^/]+\/diff$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify(routes.summary), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

function mountViewer(initial: DiffsViewerMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<DiffsViewerMountOptions>(initial);
  const dispose = render(() => <DiffsViewerView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<DiffsViewerMountOptions>) =>
      setOptions((cur) => ({ ...cur, ...next })),
  };
}

async function flush() {
  // Two ticks lets the summary fetch resolve, then the createEffect-driven
  // per-file fetch resolve. The widget polls every 5s but we don't wait
  // for that here.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const oneFile: DiffFileEntry = { file: "src/a.ts", additions: 3, deletions: 1 };
const twoFiles: DiffFileEntry[] = [
  { file: "src/a.ts", additions: 3, deletions: 1 },
  { file: "src/b.ts", additions: 1, deletions: 4 },
];

const singleFilePatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index abc..def 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,6 @@",
  " unchanged",
  "+added 1",
  "+added 2",
  "+added 3",
  "-removed 1",
].join("\n");

afterEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
});

describe("DiffsViewer (Solid widget)", () => {
  it("renders the empty state when there are no uncommitted changes", async () => {
    installFetchMock({ summary: { diff: "", files: [] } });
    const { container, dispose } = mountViewer({
      sessionName: "proj",
      apiBaseUrl: "",
      bearerToken: null,
    });
    await flush();

    expect(container.querySelector("[data-testid='diffs-viewer-empty']")).toBeTruthy();
    expect(container.querySelector("[data-testid='diffs-viewer-file-list']")).toBeNull();
    dispose();
  });

  it("renders a single-file diff with classified add/del/hunk lines", async () => {
    installFetchMock({
      summary: { diff: singleFilePatch, files: [oneFile] },
      filePatches: { "src/a.ts": singleFilePatch },
    });
    const { container, dispose } = mountViewer({
      sessionName: "proj",
      apiBaseUrl: "",
      bearerToken: null,
    });
    await flush();

    // Toolbar summary
    expect(container.textContent).toContain("1 file changed");
    expect(container.textContent).toContain("+3");
    expect(container.textContent).toContain("−1");

    // File rail has "All files" + one file
    const fileRows = container.querySelectorAll("[data-testid='diffs-viewer-file']");
    expect(fileRows.length).toBe(1);
    expect((fileRows[0] as HTMLElement).dataset.diffFilePath).toBe("src/a.ts");

    // Lines are classified — at least one add, one del, one hunk in the
    // project-wide patch ("All files" is the default selection).
    const lineKinds = Array.from(
      container.querySelectorAll<HTMLElement>("[data-diff-line-kind]"),
    ).map((el) => el.dataset.diffLineKind);
    expect(lineKinds.includes("add")).toBe(true);
    expect(lineKinds.includes("del")).toBe(true);
    expect(lineKinds.includes("hunk")).toBe(true);

    dispose();
  });

  it("renders multi-file diff and switches per-file patch on row click", async () => {
    const patchA = "diff --git a/src/a.ts b/src/a.ts\n+only-in-a\n";
    const patchB = "diff --git a/src/b.ts b/src/b.ts\n-only-in-b\n";
    installFetchMock({
      summary: { diff: patchA + patchB, files: twoFiles },
      filePatches: { "src/a.ts": patchA, "src/b.ts": patchB },
    });
    const { container, dispose } = mountViewer({
      sessionName: "proj",
      apiBaseUrl: "",
      bearerToken: null,
    });
    await flush();

    expect(container.textContent).toContain("2 files changed");
    const fileRows = container.querySelectorAll<HTMLElement>("[data-testid='diffs-viewer-file']");
    expect(fileRows.length).toBe(2);

    // Click the second file — per-file patch loads via fetchProjectFileDiff.
    const bRow = Array.from(fileRows).find((r) => r.dataset.diffFilePath === "src/b.ts");
    expect(bRow).toBeTruthy();
    bRow!.click();
    await flush();

    expect(container.textContent).toContain("only-in-b");
    expect(container.textContent).not.toContain("only-in-a");

    // Click "All files" — returns to the project-wide patch.
    const allFiles = container.querySelector<HTMLElement>("[data-testid='diffs-viewer-file-all']");
    allFiles!.click();
    await flush();

    expect(container.textContent).toContain("only-in-a");
    expect(container.textContent).toContain("only-in-b");

    dispose();
  });

  it("truncates large diffs at 2000 lines with a 'show all' control", async () => {
    // Build a synthetic patch with 2500 added lines.
    const header = ["diff --git a/big.ts b/big.ts", "@@ -1,1 +1,2500 @@"].join("\n");
    const bigPatch =
      header + "\n" + Array.from({ length: 2500 }, (_, i) => `+line-${i}`).join("\n");
    installFetchMock({
      summary: { diff: bigPatch, files: [{ file: "big.ts", additions: 2500, deletions: 0 }] },
      filePatches: { "big.ts": bigPatch },
    });
    const { container, dispose } = mountViewer({
      sessionName: "proj",
      apiBaseUrl: "",
      bearerToken: null,
    });
    await flush();

    // The truncation banner appears, and only ~2000 line elements render.
    expect(container.textContent).toContain("showing first 2000");
    const linesBefore = container.querySelectorAll("[data-diff-line-kind]").length;
    expect(linesBefore).toBeLessThanOrEqual(2000);
    expect(linesBefore).toBeGreaterThan(1900); // sanity: most of the cap

    // Clicking "show all" expands to the full set.
    const showAll = container.querySelector<HTMLElement>("[data-testid='diffs-viewer-show-all']");
    expect(showAll).toBeTruthy();
    showAll!.click();
    await flush();

    const linesAfter = container.querySelectorAll("[data-diff-line-kind]").length;
    expect(linesAfter).toBeGreaterThan(2400);
    expect(container.querySelector("[data-testid='diffs-viewer-show-all']")).toBeNull();

    dispose();
  });
});
