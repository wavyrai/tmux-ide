/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { expectFrameBounds, renderForTest } from "../testing/renderer-harness.test.ts";
import {
  ApplicationHomeSurface,
  type ApplicationHomeSurfaceProps,
} from "./application-shell-home.tsx";

function homeProps(
  overrides: Partial<ApplicationHomeSurfaceProps> = {},
): ApplicationHomeSurfaceProps {
  return {
    project: "tmux-ide",
    session: "research",
    status: "live",
    note: "Workspace ready",
    width: 80,
    height: 24,
    sessionCount: 2,
    agents: [
      { name: "Codex", activity: "running", attention: false },
      { name: "Claude", activity: "waiting", attention: true },
    ],
    branded: true,
    theme: createSemanticThemeSnapshot({ mode: "dark" }),
    onOpenTerminals: () => undefined,
    onOpenCommands: () => undefined,
    onCycleTheme: () => undefined,
    ...overrides,
  };
}

describe("compact production Home presentation", () => {
  it.each([
    [80, 24],
    [120, 40],
  ])(
    "composes fleet coverage and roster while keeping actions visible at %ix%i",
    async (width, height) => {
      const props = homeProps({
        width,
        height,
        agentInputActive: true,
        agentSelection: { selectedKey: "a", scrollOffset: 0 },
        agentRoster: {
          phase: "partial",
          observedSessions: 1,
          totalSessions: 3,
          unavailableSessions: 1,
          loadingSessions: 1,
          truncatedSessions: 0,
          refreshingSessionKeys: [],
          unavailableSessionKeys: [],
          note: null,
          rows: [
            {
              key: "a",
              sessionKey: "s",
              sessionName: "other-workspace",
              liveSessionId: "$2",
              daemonInstanceId: "d",
              agentId: "a",
              paneId: "pane.a",
              name: "quiet-otter",
              harness: "codex",
              activity: "waiting",
              attention: true,
              projectName: "tmux-ide",
            },
          ],
        },
      });
      const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
        width,
        height,
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expectFrameBounds(frame, width, height);
      expect(frame).toContain("1 observed agent");
      expect(frame).toContain("Scope: 1 of 3 sessions observed · partial");
      expect(frame).toContain("other-workspace");
      expect(frame).toContain("quiet-otter");
      expect(frame).toContain("Open terminals F2");
      expect(frame).toContain("Commands F5");
      expect(frame).not.toContain("Current session");
      setup.renderer.destroy();
    },
  );
  for (const mode of ["dark", "light"] as const) {
    it.each([
      [80, 24],
      [120, 40],
    ])("keeps a left-aligned information hierarchy at %ix%i in " + mode, async (width, height) => {
      const props = homeProps({ width, height, theme: createSemanticThemeSnapshot({ mode }) });
      const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
        width,
        height,
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expectFrameBounds(frame, width, height);
      const lines = frame.split("\n").map((line) => line.trimEnd());
      expect(lines[1]).toBe("  tmux-ide");
      expect(lines[3]).toBe("  research · live");
      expect(lines[4]).toBe("  2 sessions in view");
      expect(lines[5]).toBe("  Current session · 1 working · 1 needs attention");
      expect(frame).toContain("Open terminals F2");
      expect(frame).toContain("Commands F5");
      expect(frame).toContain(`Theme: ${mode}`);
      expect(frame).toContain("Workspace ready");
      expect(frame).not.toContain("░");
      setup.renderer.destroy();
    });
  }

  it.each([
    [1, 1],
    [8, 4],
    [20, 10],
    [39, 13],
  ])("clips tiny and Unicode content safely at %ix%i", async (width, height) => {
    const session = "分析 Café 👨‍💻 🇳🇱 1️⃣ workspace";
    const props = homeProps({ width, height, session, note: session });
    const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
      width,
      height,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expectFrameBounds(frame, width, height);
    if (height > 1) {
      const inset = width >= 12 ? 1 : 0;
      expect(frame.split("\n")[1]?.trimEnd()).toBe(
        " ".repeat(inset) + clipTerminal(`${session} · live`, width - inset * 2),
      );
    }
    expect(frame).not.toContain("\uFFFD");
    setup.renderer.destroy();
  });

  it.each([39, 80])(
    "retains all three direct actions at their displayed cells at width %i",
    async (width) => {
      const calls: string[] = [];
      const props = homeProps({
        width,
        onOpenTerminals: () => calls.push("terminals"),
        onOpenCommands: () => calls.push("commands"),
        onCycleTheme: () => calls.push("theme"),
      });
      const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
        width,
        height: 24,
      });
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split("\n");
      for (const label of ["Open terminals F2", "Commands F5", "Theme: dark"]) {
        const y = lines.findIndex((line) => line.includes(label));
        const x = lines[y]!.indexOf(label);
        const beforeHover = [...calls];
        await setup.mockMouse.moveTo(x, y);
        expect(calls).toEqual(beforeHover);
        await setup.mockMouse.click(x, y, MouseButtons.LEFT);
      }
      expect(calls).toEqual(["terminals", "commands", "theme"]);
      await setup.mockMouse.click(0, 0, MouseButtons.LEFT);
      await setup.mockInput.pressEnter();
      expect(calls).toEqual(["terminals", "commands", "theme"]);
      setup.renderer.destroy();
    },
  );

  it("distinguishes unavailable agent signals from an observed empty session", async () => {
    for (const agents of [undefined, []]) {
      const props = homeProps({ agents, onCycleTheme: undefined });
      const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
        width: 80,
        height: 24,
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain(
        agents ? "Current session · 0 working · 0 need attention" : "Agent signals unavailable",
      );
      expect(frame).not.toContain("Theme:");
      setup.renderer.destroy();
    }
  });

  it("keeps the nonbranded terminal-loading fallback free of Home actions and counts", async () => {
    const props = homeProps({
      branded: false,
      project: "Terminal workspace",
      note: "Waiting for a coherent terminal frame.",
    });
    const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
      width: 80,
      height: 24,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Terminal workspace");
    expect(frame).toContain("Waiting for a coherent terminal frame.");
    expect(frame).not.toContain("Open terminals");
    expect(frame).not.toContain("working");
    setup.renderer.destroy();
  });
});
