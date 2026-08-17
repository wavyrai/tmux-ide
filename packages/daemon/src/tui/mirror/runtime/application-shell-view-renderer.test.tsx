/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { ApplicationShellView } from "./application-shell-view.tsx";

describe("ApplicationShellView renderer", () => {
  it("renders the configless Home session picker without owning runtime behavior", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const palette = createTerminalPaletteProjection(theme);
    const setup = await renderForTest(
      () => (
        <ApplicationShellView
          dimensions={() => ({ width: 80, height: 24 })}
          surface={() => "home"}
          workspaceName={() => "no active workspace"}
          generationStatus={() => "unavailable"}
          sessions={["ordinary-one", "ordinary-two"]}
          selectedSession={() => 1}
          bootstrapNote={() => null}
          terminalRendererSource={() => null}
          layout={() => ({ current: null, windows: [] })}
          viewport={() => ({ width: 80, height: 22 })}
          focusedPane={() => null}
          theme={theme}
          palette={palette}
          onSelectPane={() => undefined}
          onResizePreview={() => undefined}
          onResizePane={() => undefined}
        />
      ),
      { width: 80, height: 24 },
    );

    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("F1 Home");
    expect(frame).toContain("F2 Terminals");
    expect(frame).toContain("ordinary-one");
    expect(frame).toContain("› ordinary-two");
    expect(frame).toContain("tmux-ide app <session>");
    setup.renderer.destroy();
  });
});
