/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";
import { GuidedTourCoach } from "./guided-tour-coach.tsx";
import { initialGuidedTourState } from "./guided-tour.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { expectFrameBounds, renderForTest } from "../testing/renderer-harness.test.ts";
describe("guided tour coach", () => {
  it("keeps keyboard input unclaimed and activates only clicked coach controls", async () => {
    const calls: string[] = [];
    const setup = await renderForTest(
      () => (
        <GuidedTourCoach
          state={{ ...initialGuidedTourState(), active: true }}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          width={68}
          height={10}
          onPause={() => calls.push("pause")}
          onWelcomeRead={() => calls.push("welcome")}
          onCreatePractice={() => {}}
          onOpenCommands={() => {}}
          onOpenAppearance={() => {}}
          onOpenHome={() => {}}
          onOpenPractice={() => {}}
        />
      ),
      { width: 80, height: 24 },
    );
    await setup.renderOnce();
    await setup.mockInput.pressEnter();
    expect(calls).toEqual([]);
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Pause tour"));
    await setup.mockMouse.click(lines[y]!.indexOf("Pause tour"), y, MouseButtons.LEFT);
    expect(calls).toEqual(["pause"]);
  });
  for (const mode of ["dark", "light"] as const) {
    for (const [width, height] of [
      [80, 24],
      [28, 10],
      [8, 6],
    ]) {
      it(`fits ${width}x${height} ${mode} with a visible pause action`, async () => {
        const setup = await renderForTest(
          () => (
            <GuidedTourCoach
              state={{ ...initialGuidedTourState(), active: true }}
              theme={createSemanticThemeSnapshot({ mode })}
              width={width!}
              height={height!}
              onPause={() => {}}
              onWelcomeRead={() => {}}
              onCreatePractice={() => {}}
              onOpenCommands={() => {}}
              onOpenAppearance={() => {}}
              onOpenHome={() => {}}
              onOpenPractice={() => {}}
            />
          ),
          { width: width!, height: height! },
        );
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expectFrameBounds(frame, width!, height!);
        expect(frame).toContain(width! >= 28 ? "Pause tour" : "Pa…");
      });
    }
  }
});
