import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ExplorerDashboardView } from "../src/widgets/ExplorerDashboard";
import type { ExplorerDashboardMountOptions, ExplorerNode } from "../src/types";

function mountWidget(initial: ExplorerDashboardMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<ExplorerDashboardMountOptions>(initial);
  const dispose = render(() => <ExplorerDashboardView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<ExplorerDashboardMountOptions>) =>
      setOptions((cur) => ({ ...cur, ...next })),
  };
}

function file(name: string, path = name): ExplorerNode {
  return { name, path, isDir: false };
}

function dir(name: string, path: string, children: ExplorerNode[] = []): ExplorerNode {
  return { name, path, isDir: true, children };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ExplorerDashboard (Solid widget)", () => {
  it("renders the empty state when no entries are passed", () => {
    const { container, dispose } = mountWidget({ rootEntries: [] });
    expect(container.querySelector("[data-testid='explorer-dashboard-empty']")).toBeTruthy();
    expect(container.querySelectorAll("[data-explorer-row]").length).toBe(0);
    dispose();
  });

  it("renders single-level files", () => {
    const tree: ExplorerNode[] = [file("README.md"), file("package.json"), file("tsconfig.json")];
    const { container, dispose } = mountWidget({ rootEntries: tree });
    const rows = container.querySelectorAll<HTMLElement>("[data-explorer-row]");
    expect(rows.length).toBe(3);
    expect(rows[0]?.getAttribute("data-explorer-row")).toBe("README.md");
    expect(rows[0]?.getAttribute("data-explorer-is-dir")).toBe("false");
    expect(container.textContent).toContain("README.md");
    expect(container.textContent).toContain("package.json");
    dispose();
  });

  it("expands and collapses nested folders on click", () => {
    const tree: ExplorerNode[] = [
      dir("src", "src", [file("a.ts", "src/a.ts"), file("b.ts", "src/b.ts")]),
      file("package.json"),
    ];
    const { container, dispose } = mountWidget({ rootEntries: tree });

    // Initially: 2 top-level rows; src/ is collapsed so a.ts + b.ts hidden.
    expect(container.querySelectorAll("[data-explorer-row]").length).toBe(2);
    const srcRow = container.querySelector<HTMLElement>("[data-explorer-row='src']");
    expect(srcRow?.getAttribute("aria-expanded")).toBe("false");

    // Click to expand.
    srcRow!.click();
    let rows = container.querySelectorAll<HTMLElement>("[data-explorer-row]");
    expect(rows.length).toBe(4); // src, a.ts, b.ts, package.json
    expect(srcRow!.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-explorer-row='src/a.ts']")).toBeTruthy();
    expect(container.querySelector("[data-explorer-row='src/b.ts']")).toBeTruthy();

    // Click to collapse again.
    srcRow!.click();
    rows = container.querySelectorAll<HTMLElement>("[data-explorer-row]");
    expect(rows.length).toBe(2);
    expect(srcRow!.getAttribute("aria-expanded")).toBe("false");

    dispose();
  });

  it("fires onSelect with path + isDir for both files and folders", () => {
    const onSelect = vi.fn();
    const tree: ExplorerNode[] = [
      dir("src", "src", [file("a.ts", "src/a.ts")]),
      file("package.json"),
    ];
    const { container, dispose } = mountWidget({ rootEntries: tree, onSelect });

    // Click folder — onSelect fires AND folder expands.
    container.querySelector<HTMLElement>("[data-explorer-row='src']")!.click();
    expect(onSelect).toHaveBeenLastCalledWith("src", true);

    // Click nested file.
    container.querySelector<HTMLElement>("[data-explorer-row='src/a.ts']")!.click();
    expect(onSelect).toHaveBeenLastCalledWith("src/a.ts", false);

    // Click root file.
    container.querySelector<HTMLElement>("[data-explorer-row='package.json']")!.click();
    expect(onSelect).toHaveBeenLastCalledWith("package.json", false);

    expect(onSelect).toHaveBeenCalledTimes(3);
    dispose();
  });

  it("hides gitignored entries by default and shows them dimmed when filter is off", () => {
    const tree: ExplorerNode[] = [
      file("README.md"),
      { ...file("node_modules", "node_modules"), isDir: true, ignored: true, children: [] },
    ];
    const { container, setOptions, dispose } = mountWidget({ rootEntries: tree });

    // Default: filter ON → node_modules hidden.
    expect(container.querySelector("[data-explorer-row='node_modules']")).toBeNull();

    // Toggle filter OFF → node_modules visible with reduced opacity.
    setOptions({ gitignoreFilter: false });
    const ignored = container.querySelector<HTMLElement>("[data-explorer-row='node_modules']");
    expect(ignored).toBeTruthy();
    expect(ignored?.getAttribute("data-explorer-ignored")).toBe("true");
    // Inline opacity reflects the dim state.
    expect(ignored?.style.opacity).toBe("0.6");

    dispose();
  });

  it("renders a large tree (50+ nodes) without crashing", () => {
    // 5 dirs × 10 files each = 50 leaves + 5 dirs = 55 nodes total.
    const tree: ExplorerNode[] = Array.from({ length: 5 }, (_, di) =>
      dir(
        `dir${di}`,
        `dir${di}`,
        Array.from({ length: 10 }, (_, fi) => file(`file${fi}.ts`, `dir${di}/file${fi}.ts`)),
      ),
    );
    const { container, dispose } = mountWidget({
      rootEntries: tree,
      defaultExpanded: true,
    });

    // defaultExpanded → all dirs open → 5 dirs + 50 files = 55 rows.
    const rows = container.querySelectorAll("[data-explorer-row]");
    expect(rows.length).toBe(55);

    // Folder count badges visible on each dir (10 children each).
    const dir0 = container.querySelector("[data-explorer-row='dir0']");
    expect(dir0?.textContent).toContain("10");

    dispose();
  });

  it("highlights the selectedPath via accent color + aria-selected", () => {
    const tree: ExplorerNode[] = [
      dir("src", "src", [file("a.ts", "src/a.ts"), file("b.ts", "src/b.ts")]),
    ];
    const { container, dispose } = mountWidget({
      rootEntries: tree,
      selectedPath: "src/b.ts",
      defaultExpanded: true,
    });

    const b = container.querySelector<HTMLElement>("[data-explorer-row='src/b.ts']");
    expect(b?.getAttribute("aria-selected")).toBe("true");
    expect(b?.getAttribute("data-explorer-selected")).toBe("true");
    // Inline color picks up the design token.
    expect(b?.style.color).toBe("var(--accent)");

    const a = container.querySelector<HTMLElement>("[data-explorer-row='src/a.ts']");
    expect(a?.getAttribute("aria-selected")).toBe("false");

    dispose();
  });
});
