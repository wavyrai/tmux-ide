import { describe, expect, it } from "vitest";

import {
  CARD5_ACTIVE_TERMINAL_PANEL,
  card5ProbeBootstrapRequested,
  installCard5ProbeBootstrap,
  resolveCard5QualifiedTerminalSurface,
} from "./card5-probe-bootstrap.ts";

function surface(input: {
  phase?: string;
  preservesFrame?: boolean;
  width?: number;
  height?: number;
  display?: string;
  visibility?: string;
  workspace?: string;
  pane?: string;
}) {
  const width = input.width ?? 640;
  const height = input.height ?? 360;
  const attributes = new Map([
    ["data-phase", input.phase ?? "connected"],
    ["data-preserves-frame", String(input.preservesFrame ?? true)],
    ["data-workspace-name", input.workspace ?? "workspace-a"],
    ["data-semantic-pane-id", input.pane ?? "pane-a"],
  ]);
  return {
    style: { display: input.display ?? "block", visibility: input.visibility ?? "visible" },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    getBoundingClientRect: () => ({ width, height }),
    getClientRects: () =>
      width > 0 && height > 0 && input.display !== "none" ? ([{}] as unknown as DOMRectList) : [],
  } as unknown as Element;
}

function resolve(
  surfaces: readonly Element[],
  options: {
    panel?: boolean;
    documentVisible?: boolean;
    mode?: "readiness" | "observation";
  } = {},
) {
  const panel = {
    getBoundingClientRect: () => ({ width: 800, height: 500 }),
    getClientRects: () => [{}],
    querySelectorAll: () => surfaces,
  } as unknown as Element;
  return resolveCard5QualifiedTerminalSurface(
    {
      visibilityState: options.documentVisible === false ? "hidden" : "visible",
      querySelector: (selector: string) =>
        options.panel === false || selector !== CARD5_ACTIVE_TERMINAL_PANEL ? null : panel,
    } as Pick<Document, "visibilityState" | "querySelector">,
    {
      getComputedStyle: (element: Element) =>
        (element as unknown as { style: CSSStyleDeclaration }).style,
    },
    options.mode,
  );
}

describe("Card5 initial renderer probe bootstrap", () => {
  it("installs both probes before render for one exact loopback opt-in", () => {
    const globals: Record<string, unknown> = {};
    expect(
      installCard5ProbeBootstrap("http://127.0.0.1:4173/?tmuxIdeCard5Evidence=1", globals),
    ).toBe(true);
    expect(globals).toMatchObject({
      __TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__: true,
      __TMUX_IDE_CARD5_EVIDENCE_ENABLED__: true,
    });
    expect(globals.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__).toBeTypeOf("function");
  });

  it("uses one existential active-panel resolver for readiness and every capture", () => {
    const hiddenA = surface({ display: "none", workspace: "workspace-a", pane: "pane-a" });
    const visibleB = surface({ workspace: "workspace-b", pane: "pane-b" });
    const readinessAuthority = resolve([hiddenA, visibleB]);
    const laterCaptureAuthority = resolve([hiddenA, visibleB]);
    expect(readinessAuthority).toBe(visibleB);
    expect(laterCaptureAuthority).toBe(readinessAuthority);
    expect(resolve([hiddenA])).toBeNull();
    expect(resolve([visibleB], { panel: false })).toBeNull();
    expect(resolve([visibleB], { documentVisible: false })).toBeNull();
    expect(resolve([visibleB], { documentVisible: false, mode: "observation" })).toBe(visibleB);
  });

  it("changes authority only when the previously qualified identity is replaced", () => {
    const hiddenA = surface({ display: "none", workspace: "workspace-a", pane: "pane-a" });
    const visibleB = surface({ workspace: "workspace-b", pane: "pane-b" });
    const visibleC = surface({ workspace: "workspace-c", pane: "pane-c" });
    expect(resolve([hiddenA, visibleB])).toBe(visibleB);
    expect(resolve([hiddenA, visibleC])).toBe(visibleC);
  });

  it.each([
    { phase: "measuring" },
    { phase: "connecting" },
    { phase: "error" },
    { width: 0 },
    { height: 0 },
    { preservesFrame: false },
    { visibility: "hidden" },
  ])("rejects an unqualified terminal surface: %j", (input) => {
    expect(resolve([surface(input)])).toBeNull();
  });

  it.each([
    "https://127.0.0.1:4173/?tmuxIdeCard5Evidence=1",
    "http://example.test:4173/?tmuxIdeCard5Evidence=1",
    "http://127.0.0.1/?tmuxIdeCard5Evidence=1",
    "http://user@127.0.0.1:4173/?tmuxIdeCard5Evidence=1",
    "http://127.0.0.1:4173/?tmuxIdeCard5Evidence=0",
    "http://127.0.0.1:4173/?tmuxIdeCard5Evidence=1&tmuxIdeCard5Evidence=1",
  ])("rejects an inexact or non-loopback URL: %s", (value) => {
    expect(card5ProbeBootstrapRequested(value)).toBe(false);
  });
});
