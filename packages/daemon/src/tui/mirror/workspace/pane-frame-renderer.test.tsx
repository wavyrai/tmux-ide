/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { describe, expect, it } from "bun:test";
import { SelectableRow } from "../recipes.tsx";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { paneFrameHitTest, projectPaneFrame } from "./pane-frame.ts";
import { PaneFrame } from "./pane-frame.tsx";

const actions = [
  { id: "zoom", label: "zoom", compactLabel: "Z", description: "Toggle zoom" },
  { id: "split", label: "split", compactLabel: "+", description: "Split pane" },
  { id: "more", label: "more", compactLabel: "…", description: "More actions" },
] as const;

async function renderPane(width: number, height: number) {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const calls: string[] = [];
  let focusedValue = true;
  let statusValue = "working";

  function Harness() {
    const [focused, setFocused] = createSignal(focusedValue);
    const [status, setStatus] = createSignal(statusValue);
    const projection = () =>
      projectPaneFrame({
        width,
        height,
        title: "Codex implementer",
        kind: "terminals",
        subtitle: "%7 · task/142-pane-frame",
        focused: focused(),
        terminalFocused: focused(),
        attention: status() === "blocked",
        dirty: true,
        status: status(),
        statusTone: status() === "blocked" ? "blocked" : "working",
        actions,
      });
    useKeyboard((event) => {
      if (event.name === "f") {
        focusedValue = !focused();
        setFocused(focusedValue);
        calls.push("keyboard:focus");
      }
      if (event.name === "b") {
        statusValue = "blocked";
        setStatus(statusValue);
        calls.push("keyboard:block");
      }
    });
    return (
      <box
        width={width}
        height={height}
        overflow="hidden"
        onMouseDown={(event) => {
          const hit = paneFrameHitTest(projection(), event.x, event.y);
          if (hit?.area === "header" && hit.actionId) calls.push(`mouse:${hit.actionId}`);
        }}
      >
        <PaneFrame theme={theme} projection={projection()}>
          <SelectableRow
            theme={theme}
            label="Mission: ship application-grade window chrome"
            meta="M31"
            width={width}
            selected
          />
          <SelectableRow
            theme={theme}
            label="Task: PaneFrame projection and renderer"
            meta="running"
            width={width}
            focused
          />
          <SelectableRow
            theme={theme}
            label="Harness: Codex"
            meta="gpt-5.5"
            width={width}
            status="working"
            tone="working"
          />
          <text fg={theme.colors.mutedForeground}> terminal framebuffer remains opaque</text>
        </PaneFrame>
      </box>
    );
  }

  const setup = await renderForTest(() => <Harness />, { width, height });
  await setup.renderOnce();
  return {
    setup,
    calls,
    focused: () => focusedValue,
    status: () => statusValue,
    projection: () =>
      projectPaneFrame({
        width,
        height,
        title: "Codex implementer",
        kind: "terminals",
        subtitle: "%7 · task/142-pane-frame",
        focused: focusedValue,
        terminalFocused: focusedValue,
        attention: statusValue === "blocked",
        dirty: true,
        status: statusValue,
        statusTone: statusValue === "blocked" ? "blocked" : "working",
        actions,
      }),
    frame: () => setup.captureCharFrame(),
  };
}

describe("PaneFrame OpenTUI renderer", () => {
  it.each([
    [80, 24, "standard"],
    [120, 40, "wide"],
    [200, 60, "wide"],
  ] as const)("renders the %sx%s %s window chrome", async (width, height, variant) => {
    const harness = await renderPane(width, height);
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(harness.projection().variant).toBe(variant);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain("Codex implementer");
    expect(stableFrame(frame)).toContain("working");
    expect(stableFrame(frame)).toContain("zoom");
  });

  it("routes projected action spans and keeps keyboard ownership in the harness", async () => {
    const harness = await renderPane(120, 40);
    const zoom = harness.projection().actions.find((action) => action.id === "zoom")!;
    await harness.setup.mockMouse.click(
      zoom.start + Math.floor(zoom.width / 2),
      0,
      MouseButtons.LEFT,
    );
    harness.setup.mockInput.pressKey("b");
    await harness.setup.renderOnce();
    expect(harness.status()).toBe("blocked");
    expect(stableFrame(harness.frame())).toContain("blocked");
    expect(harness.calls).toEqual(["mouse:zoom", "keyboard:block"]);
  });
});
