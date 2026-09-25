import type { InteractionReceipt } from "@tmux-ide/contracts";
/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { readFileSync } from "node:fs";
import { APPLICATION_HOME_WORDMARK } from "../ui/home-wordmark.ts";

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
  it("reuses the exact marketing-site ASCII wordmark", () => {
    const svg = readFileSync(
      new URL("../../../../../../docs/public/ascii-wordmark.svg", import.meta.url),
      "utf8",
    );
    const rows = [...svg.matchAll(/<text x="0" y="\d+">([^<]*)<\/text>/gu)].map(
      (match) => match[1],
    );
    expect(APPLICATION_HOME_WORDMARK).toEqual(rows);
  });
  it("reserves the ASCII logo for an observed empty fleet, not loading or search results", async () => {
    for (const [phase, query, expected] of [
      ["live", "", true],
      ["live", "missing", false],
      ["loading", "", false],
      ["partial", "", false],
      ["unavailable", "", false],
    ] as const) {
      const setup = await renderForTest(
        () => (
          <ApplicationHomeSurface
            {...homeProps({
              width: 120,
              height: 40,
              agentQuery: query,
              agentRoster: {
                phase,
                rows: [],
                observedSessions: 0,
                totalSessions: 0,
                loadingSessions: 0,
                unavailableSessions: 0,
                truncatedSessions: 0,
                refreshingSessionKeys: [],
                unavailableSessionKeys: [],
                note: null,
              },
            })}
          />
        ),
        { width: 120, height: 40 },
      );
      try {
        await setup.renderOnce();
        expect(setup.captureCharFrame().includes(APPLICATION_HOME_WORDMARK[2])).toBe(expected);
      } finally {
        setup.renderer.destroy();
      }
    }
  });
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
    ])("centers a bounded information column at %ix%i in " + mode, async (width, height) => {
      const props = homeProps({ width, height, theme: createSemanticThemeSnapshot({ mode }) });
      const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
        width,
        height,
      });
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expectFrameBounds(frame, width, height);
      const lines = frame.split("\n").map((line) => line.trimEnd());
      const left = " ".repeat(Math.max(2, Math.floor((width - 96) / 2)));
      expect(lines[1]).toBe(`${left}tmux-ide`);
      expect(lines[3]).toBe(`${left}research · live`);
      expect(lines[4]).toBe(`${left}2 sessions in view`);
      expect(lines[5]).toBe(`${left}Current session · 1 working · 1 needs attention`);
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

describe("Home observed pane activity", () => {
  const receipt: InteractionReceipt = {
    type: "interaction.receipt",
    sequence: 1,
    operationId: "10000000-0000-4000-8000-000000000001",
    origin: "external",
    workspaceName: "research",
    sourceSemanticPaneId: null,
    target: { kind: "pane", semanticPaneId: "pane.tests" },
    operationKind: "workspace.pane.read",
    summary: { operationKind: "workspace.pane.read", observedOnly: true },
    phase: "observed",
    proof: { operationKind: "workspace.pane.read", observed: true, semanticPaneId: "pane.tests" },
    at: "2026-09-08T10:00:00.000Z",
    resourceRevision: null,
  };
  const activityProps = (overrides: Partial<ApplicationHomeSurfaceProps> = {}) =>
    homeProps({
      activityDaemonId: "daemon-local",
      agentSelection: { selectedKey: "tests", scrollOffset: 0 },
      agentRoster: {
        phase: "live",
        observedSessions: 1,
        totalSessions: 1,
        loadingSessions: 0,
        unavailableSessions: 0,
        truncatedSessions: 0,
        refreshingSessionKeys: [],
        unavailableSessionKeys: [],
        note: null,
        rows: [
          {
            key: "tests",
            sessionKey: "research",
            sessionName: "research",
            liveSessionId: "$1",
            daemonInstanceId: "daemon-local",
            agentId: "tests",
            paneId: "pane.tests",
            name: "Tests",
            harness: "codex",
            activity: "running",
            attention: false,
            projectName: "research",
          },
        ],
      },
      ...overrides,
    });
  it("shows safe observed relationships without inventing an agent identity or rendering payloads", async () => {
    const props = activityProps({
      recentPaneActivity: [Object.assign({}, receipt, { content: "SECRET_PANE_CONTENT" })],
    });
    const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
      width: 80,
      height: 24,
    });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Tests · latest activity");
      expect(frame).toContain("09-08 10:00Z");
      expect(frame).toContain("External reader reads Tests");
      expect(frame).toContain("Activity reported through tmux-ide");
      expect(frame).not.toContain("SECRET_PANE_CONTENT");
      expect(frame).toContain("Open terminals");
      expectFrameBounds(frame, 80, 24);
    } finally {
      setup.renderer.destroy();
    }
  });
  it.each([
    ["accepted", "reading"],
    ["observed", "read"],
    ["rejected", "failed"],
    ["timed-out", "timed out"],
  ] as const)("keeps %s activity explicit with secondary timestamps", async (phase, label) => {
    const setup = await renderForTest(
      () => (
        <ApplicationHomeSurface
          {...activityProps({
            height: 32,
            recentPaneActivity: [{ ...receipt, phase } as InteractionReceipt],
          })}
        />
      ),
      { width: 80, height: 32 },
    );
    try {
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex((line) => line.includes("External reader reads Tests"));
      expect(row).toBeGreaterThan(-1);
      expect(lines[row]!.trimEnd().endsWith(label)).toBe(true);
      expect(lines[row + 1]).toContain("09-08 10:00Z");
      expect(lines[row]).not.toContain("09-08");
    } finally {
      setup.renderer.destroy();
    }
  });
  it("only reveals activity for the selected agent on its originating daemon", async () => {
    const base = activityProps({ height: 32 });
    const [selectedKey, setSelectedKey] = createSignal<string | null>("tests");
    const [daemonId, setDaemonId] = createSignal<string | null>("daemon-local");
    const setup = await renderForTest(
      () => (
        <ApplicationHomeSurface
          {...base}
          activityDaemonId={daemonId()}
          agentSelection={{ selectedKey: selectedKey(), scrollOffset: 0 }}
          recentPaneActivity={[
            receipt,
            { ...receipt, workspaceName: "another-workspace", at: "2026-09-09T12:00:00Z" },
          ]}
        />
      ),
      { width: 80, height: 32 },
    );
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Tests · latest activity");
      expect(setup.captureCharFrame()).not.toContain("09-09 12:00Z");
      setSelectedKey(null);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("latest activity");
      setSelectedKey("tests");
      setDaemonId("daemon-remote");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("latest activity");
      setDaemonId(null);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("latest activity");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("preserves Home controls in a short terminal by omitting the optional feed", async () => {
    const props = activityProps({
      width: 40,
      height: 14,
      recentPaneActivity: [receipt, receipt, receipt],
    });
    const setup = await renderForTest(() => <ApplicationHomeSurface {...props} />, {
      width: 40,
      height: 14,
    });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("Tests · latest activity");
      expect(frame).toContain("Open terminals");
      expectFrameBounds(frame, 40, 14);
    } finally {
      setup.renderer.destroy();
    }
  });
});
