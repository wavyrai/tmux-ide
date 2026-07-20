/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { projectAgentTerminalCanvas } from "./agent-terminal-canvas.ts";
import { AgentTerminalCanvas } from "./agent-terminal-canvas-view.tsx";

describe("AgentTerminalCanvas OpenTUI renderer", () => {
  it.each([
    [80, 24],
    [120, 40],
    [200, 60],
  ] as const)("keeps native chrome outside the %sx%s framebuffer", async (width, height) => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const projection = projectAgentTerminalCanvas({
      width,
      height,
      chromeRows: 2,
      footerRows: 1,
    });
    const setup = await renderForTest(
      () => (
        <AgentTerminalCanvas
          theme={theme}
          projection={projection}
          chrome={
            <>
              <text fg={theme.colors.foreground}> mission-control · live</text>
              <text fg={theme.colors.mutedForeground}> 0:agents 1:shell</text>
            </>
          }
          framebuffer={
            <box width={projection.framebuffer.width} height={projection.framebuffer.height}>
              <text fg={theme.colors.accent}>
                tmux framebuffer {`${projection.tmuxSize!.cols}x${projection.tmuxSize!.rows}`}
              </text>
            </box>
          }
          footer={<text fg={theme.colors.mutedForeground}> /blocked 1/3</text>}
        />
      ),
      { width, height },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expectFrameBounds(frame, width, height);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain("mission-control · live");
    expect(stableFrame(frame)).toContain(
      `tmux framebuffer ${projection.tmuxSize!.cols}x${projection.tmuxSize!.rows}`,
    );
    expect(stableFrame(frame)).toContain("/blocked 1/3");
  });
});
