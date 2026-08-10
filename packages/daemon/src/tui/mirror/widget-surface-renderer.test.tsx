/* @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot } from "./theme.ts";
import { renderForTest } from "./testing/renderer-harness.test.ts";
import { TuiRichWidgetSurface } from "./widget-surface.tsx";

describe("OpenTUI rich widget surface", () => {
  it("renders Markdown as structured terminal UI with pane escape chrome", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: theme.roles.text.primary },
      "markup.heading": { fg: theme.colors.accent, bold: true },
    });
    const setup = await renderForTest(
      () => (
        <box position="relative" width={54} height={12}>
          <TuiRichWidgetSurface
            theme={theme}
            syntaxStyle={syntaxStyle}
            width={54}
            height={12}
            surface={{
              kind: "markdown",
              label: "Markdown",
              title: "PLAN.md",
              text: "# Release plan\n\n- [x] Shared contract\n- [ ] Ship it",
            }}
          />
        </box>
      ),
      { width: 54, height: 12 },
    );
    const frame = await setup.waitForFrame((candidate) => candidate.includes("Release plan"), {
      maxFrames: 20,
    });
    expect(frame).toContain("PLAN.md  ·  Ctrl-C to return");
    expect(frame).toContain("Release plan");
    expect(frame).toContain("Shared contract");
    setup.renderer.destroy();
    syntaxStyle.destroy();
  });
});
