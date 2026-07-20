import { describe, expect, it } from "vitest";
import { buildHostedPanelViews } from "../panel-host.ts";
import {
  applicationShellHitTest,
  projectApplicationShell,
  type ApplicationShellInput,
} from "./application-shell.ts";

const views = buildHostedPanelViews([
  { id: "home", title: "Home", panel: "home" },
  { id: "terminal", title: "Terminal", panel: "terminals" },
  { id: "files", title: "Files", panel: "files" },
  { id: "missions", title: "Missions", panel: "missions" },
]);

function input(overrides: Partial<ApplicationShellInput> = {}): ApplicationShellInput {
  return {
    width: 120,
    height: 40,
    preferredSidebarWidth: 28,
    views,
    activeViewId: "terminal",
    hoveredTabIndex: null,
    attentionViewIds: new Set(["missions"]),
    sessions: [
      { name: "web", status: "working" },
      { name: "api", status: "blocked" },
    ],
    activeSession: "web",
    quitHint: "^q quit",
    ...overrides,
  };
}

describe("application shell projection", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("projects a bounded %sx%s %s workspace", (width, height, variant) => {
    const projection = projectApplicationShell(input({ width, height }));
    expect(projection.layout.variant).toBe(variant);
    expect(projection.layout.width).toBe(width);
    expect(projection.layout.height).toBe(height);
    expect(projection.content.width).toBe(projection.layout.main.width);
    expect(projection.content.height + projection.layout.status.height).toBe(
      projection.layout.main.height,
    );
    expect(projection.tabs.find((tab) => tab.id === "terminal")?.selected).toBe(true);
    expect(projection.tabs.find((tab) => tab.id === "missions")?.attention).toBe(true);
  });

  it("routes tab, session, and palette hits from the rendered geometry", () => {
    const projection = projectApplicationShell(input());
    const files = projection.tabs.find((tab) => tab.id === "files")!;
    expect(
      applicationShellHitTest(projection, files.span.start + Math.floor(files.span.width / 2), 0),
    ).toEqual({ kind: "view", viewId: "files", index: 2 });

    expect(applicationShellHitTest(projection, 2, projection.layout.sidebar.y + 1)).toEqual({
      kind: "session",
      session: "web",
      index: 0,
    });

    const hint = projection.sidebarHint.buttonSpan;
    expect(
      applicationShellHitTest(
        projection,
        projection.layout.sidebar.x + hint.start,
        projection.layout.sidebar.y + projection.layout.sidebar.height - 1,
      ),
    ).toEqual({ kind: "palette" });
  });

  it("leaves content and out-of-bounds cells to the active surface", () => {
    const projection = projectApplicationShell(input());
    expect(
      applicationShellHitTest(projection, projection.content.x + 2, projection.content.y + 2),
    ).toBeNull();
    expect(applicationShellHitTest(projection, -1, 0)).toBeNull();
    expect(applicationShellHitTest(projection, projection.layout.width, 0)).toBeNull();
  });
});
