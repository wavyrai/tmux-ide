import { describe, expect, it } from "vitest";
import {
  GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  GROUPED_TMUX_VIEW_SESSION_PREFIX,
  GroupedTmuxAttachmentPlanInputSchemaZ,
  groupedTmuxViewSessionName,
  planGroupedTmuxAttachment,
} from "../attachments/grouped-tmux.ts";

const attachmentId = "f3d8bc0b-460c-458c-b9c0-dbc2536d1486";

function input(overrides: Record<string, unknown> = {}) {
  return {
    attachmentId,
    generation: 2,
    target: {
      workspaceName: "workspace.alpha",
      semanticPaneId: "pane.implementer-2",
    },
    viewerMode: "interactive" as const,
    viewport: { cols: 120, rows: 40 },
    source: {
      sessionId: "$12",
      windowId: "@34",
      runtimePaneId: "%56",
      windowPaneCount: 1,
    },
    ...overrides,
  };
}

function everyArgv(plan: ReturnType<typeof planGroupedTmuxAttachment>): readonly string[][] {
  return [
    plan.create.absenceProbe.argv,
    plan.create.command.argv,
    plan.attach.argv,
    plan.detach.argv,
    plan.recover.existenceProbe.argv,
    plan.recover.ownership.query.argv,
    plan.recover.topology.query.argv,
    ...plan.recover.reconcile.map((command) => command.argv),
    plan.recover.attach.argv,
    plan.cleanup.ownership.query.argv,
    plan.cleanup.command.argv,
  ];
}

describe("grouped tmux attachment planner", () => {
  it("builds a deterministic, bounded, collision-generation-aware view name", () => {
    const first = groupedTmuxViewSessionName(attachmentId, 2);
    expect(first).toBe(groupedTmuxViewSessionName(attachmentId, 2));
    expect(first).toMatch(/^_tmux-ide-view-v1-[a-f0-9]{32}-2$/u);
    expect(first.startsWith(GROUPED_TMUX_VIEW_SESSION_PREFIX)).toBe(true);
    expect(groupedTmuxViewSessionName(attachmentId, 3)).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(64);
  });

  it("creates an isolated marked view linking only the trusted source window", () => {
    const plan = planGroupedTmuxAttachment(input());
    const view = plan.identity.viewSessionName;
    expect(plan.create.command).toEqual({
      executable: "tmux",
      argv: expect.arrayContaining([
        "new-session",
        "-d",
        "-s",
        view,
        "__tmux_ide_attachment_placeholder",
        GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
        plan.identity.markerValue,
        "link-window",
        "$12:@34",
        "unlink-window",
      ]),
    });
    expect(plan.create.command.argv.slice(0, 3)).toEqual(["new-session", "-d", "-s"]);
    expect(plan.create.command.argv).not.toContain("%56");
    expect(plan.recover.reconcile.map((entry) => entry.argv)).toEqual([
      ["select-window", "-t", `${view}:@34`],
      ["set-option", "-t", view, "status", "off"],
      ["set-option", "-t", view, "destroy-unattached", "off"],
    ]);
    expect(plan.recover.topology).toEqual({
      query: {
        executable: "tmux",
        argv: ["list-windows", "-t", `=${view}`, "-F", "#{window_id}"],
      },
      expectedStdout: "@34",
    });
  });

  it("accepts tmux's zero-valued first runtime identities", () => {
    expect(
      GroupedTmuxAttachmentPlanInputSchemaZ.safeParse(
        input({
          source: { sessionId: "$0", windowId: "@0", runtimePaneId: "%0", windowPaneCount: 1 },
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a multi-pane linked window (m41 attach-2) and keeps single-pane plans identical", () => {
    for (const windowPaneCount of [2, 9, 64]) {
      const parsed = GroupedTmuxAttachmentPlanInputSchemaZ.safeParse(
        input({ source: { ...input().source, windowPaneCount } }),
      );
      expect(parsed.success).toBe(true);
      // The pane count is a window proof, not part of the durable target, so a
      // multi-pane plan is byte-identical to the single-pane plan otherwise.
      expect(planGroupedTmuxAttachment(input({ source: { ...input().source, windowPaneCount } }))).toEqual(
        planGroupedTmuxAttachment(input()),
      );
    }
  });

  it("uses exact safe interactive and read-only client argv for attach and recovery", () => {
    const interactive = planGroupedTmuxAttachment(input());
    const readOnly = planGroupedTmuxAttachment(input({ viewerMode: "read-only" }));
    // The interactive client is size-passive (`-f ignore-size`, m41 attach-2)
    // so it never drives the shared window's size. Read-only's `-r` already
    // implies read-only + ignore-size.
    const interactiveAttachArgv = [
      "attach-session",
      "-E",
      "-f",
      "ignore-size",
      "-t",
      `=${interactive.identity.viewSessionName}`,
    ];
    const readOnlyAttachArgv = [
      "attach-session",
      "-E",
      "-r",
      "-t",
      `=${readOnly.identity.viewSessionName}`,
    ];
    expect(interactive.attach.argv).toEqual(interactiveAttachArgv);
    expect(interactive.recover.attach.argv).toEqual(interactiveAttachArgv);
    expect(readOnly.attach.argv).toEqual(readOnlyAttachArgv);
    // Size passivity must come only from the client flag; the plan never writes
    // window-size or issues a resize.
    for (const argv of everyArgv(interactive)) {
      expect(argv).not.toContain("resize-window");
      expect(argv).not.toContain("window-size");
    }
    expect(readOnly.recover.attach.argv).toEqual(readOnlyAttachArgv);
    for (const argv of everyArgv(readOnly)) {
      expect(argv).not.toContain("set-window-option");
      expect(argv).not.toContain("resize-window");
      expect(argv).not.toContain("-w");
      expect(argv).not.toContain("window-size");
    }
  });

  it("keeps attach, detach, recover, and cleanup deterministic", () => {
    const first = planGroupedTmuxAttachment(input());
    const second = planGroupedTmuxAttachment(input());
    expect(second).toEqual(first);
    expect(first.recover.attach).toBe(first.attach);
    expect(first.cleanup.ownership.expectedStdout).toBe(
      `${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}=${first.identity.markerValue}`,
    );
    expect(first.recover.topology.expectedStdout).toBe(first.identity.durableSource.windowId);
    expect(first.cleanup.command.argv).toEqual([
      "kill-session",
      "-t",
      `=${first.identity.viewSessionName}`,
    ]);
  });

  it("can clean only the exact daemon-marked view and never the durable source", () => {
    const plan = planGroupedTmuxAttachment(input());
    expect(plan.cleanup.ownership.query.argv).toEqual([
      "show-environment",
      "-t",
      `=${plan.identity.viewSessionName}`,
      GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
    ]);
    expect(plan.cleanup.ownership.expectedStdout).toBe(
      `${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}=${plan.identity.markerValue}`,
    );
    expect(plan.cleanup.command.argv.at(-1)).toBe(`=${plan.identity.viewSessionName}`);

    const argv = everyArgv(plan);
    expect(argv.flat()).not.toContain("kill-pane");
    expect(argv.flat()).not.toContain("kill-window");
    for (const command of argv.filter((entry) => entry[0]?.startsWith("kill-"))) {
      expect(command).not.toContain(plan.identity.durableSource.sessionId);
      expect(command).not.toContain(plan.identity.durableSource.windowId);
      expect(command).not.toContain(plan.identity.durableSource.runtimePaneId);
    }
  });

  it("never turns alternate semantic workspace or pane ids into tmux argv", () => {
    const semanticTarget = {
      workspaceName: "monorepo.api-v2",
      semanticPaneId: "pane.claude_reviewer-9",
    };
    const plan = planGroupedTmuxAttachment(input({ target: semanticTarget }));
    expect(plan.identity.semanticTarget).toEqual(semanticTarget);
    for (const argv of everyArgv(plan)) {
      expect(argv).not.toContain(semanticTarget.workspaceName);
      expect(argv).not.toContain(semanticTarget.semanticPaneId);
    }
  });

  it("rejects hostile or ambiguous runtime strings before planning targets", () => {
    for (const source of [
      { ...input().source, sessionId: "$12;kill-server" },
      { ...input().source, sessionId: "owner:@34" },
      { ...input().source, windowId: "@34;run-shell" },
      { ...input().source, runtimePaneId: "%56 $(touch-pwned)" },
      // A window pane count is a positive integer; zero and fractional counts
      // are still rejected even though the single-pane gate is gone.
      { ...input().source, windowPaneCount: 0 },
      { ...input().source, windowPaneCount: 1.5 },
    ]) {
      expect(GroupedTmuxAttachmentPlanInputSchemaZ.safeParse(input({ source })).success).toBe(
        false,
      );
      expect(() => planGroupedTmuxAttachment(input({ source }) as never)).toThrow();
    }
  });
});
