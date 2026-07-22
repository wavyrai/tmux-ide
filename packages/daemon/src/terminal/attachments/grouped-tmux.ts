import { z } from "zod";
import {
  TerminalAttachmentSemanticTargetSchemaZ,
  TerminalAttachmentViewerModeSchemaZ,
  TerminalAttachmentViewportSchemaZ,
  type TerminalAttachmentSemanticTarget,
  type TerminalAttachmentViewerMode,
  type TerminalAttachmentViewport,
} from "@tmux-ide/contracts";

/** Namespace reserved for daemon-owned, disposable grouped view sessions. */
export const GROUPED_TMUX_VIEW_SESSION_PREFIX = "_tmux-ide-view-v1-" as const;
/**
 * Session-local ownership proof. tmux has no pane/window scope for environment
 * entries, unlike `@` user options whose effective format value can be
 * shadowed by a linked pane or window.
 */
export const GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT = "TMUX_IDE_ATTACHMENT_VIEW" as const;
export const GROUPED_TMUX_MAX_GENERATION = 65_535;
const GROUPED_TMUX_PLACEHOLDER_WINDOW = "__tmux_ide_attachment_placeholder" as const;
const GROUPED_TMUX_PLACEHOLDER_COMMAND = "exec sleep 2147483647" as const;

const RuntimeSessionIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^\$(?:0|[1-9][0-9]*)$/u, "source session id must be a tmux runtime id");
const RuntimeWindowIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^@(?:0|[1-9][0-9]*)$/u, "source window id must be a tmux runtime id");
const RuntimePaneIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^%(?:0|[1-9][0-9]*)$/u, "source pane id must be a tmux runtime id");

/**
 * This input exists only behind the daemon's semantic-id resolver. In
 * particular, its runtime ids are not part of the browser contract.
 */
export const GroupedTmuxAttachmentPlanInputSchemaZ = z
  .object({
    attachmentId: z.uuid(),
    generation: z.number().int().min(0).max(GROUPED_TMUX_MAX_GENERATION),
    target: TerminalAttachmentSemanticTargetSchemaZ,
    viewerMode: TerminalAttachmentViewerModeSchemaZ,
    viewport: TerminalAttachmentViewportSchemaZ,
    source: z
      .object({
        sessionId: RuntimeSessionIdSchemaZ,
        windowId: RuntimeWindowIdSchemaZ,
        runtimePaneId: RuntimePaneIdSchemaZ,
        /** Grouped views are valid only after discovery proves this invariant. */
        paneCount: z.literal(1),
      })
      .strict(),
  })
  .strict();
export type GroupedTmuxAttachmentPlanInput = z.infer<typeof GroupedTmuxAttachmentPlanInputSchemaZ>;

export interface TmuxArgvPlan {
  readonly executable: "tmux";
  readonly argv: readonly string[];
}

export interface TmuxOutputGate {
  readonly query: TmuxArgvPlan;
  readonly expectedStdout: string;
}

export interface GroupedTmuxAttachmentPlan {
  readonly identity: {
    readonly attachmentId: string;
    readonly generation: number;
    readonly viewSessionName: string;
    readonly markerEnvironment: typeof GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT;
    readonly markerValue: string;
    readonly semanticTarget: TerminalAttachmentSemanticTarget;
    readonly durableSource: {
      readonly sessionId: string;
      readonly windowId: string;
      readonly runtimePaneId: string;
    };
  };
  readonly viewerMode: TerminalAttachmentViewerMode;
  readonly viewport: TerminalAttachmentViewport;
  readonly create: {
    readonly absenceProbe: TmuxArgvPlan;
    readonly command: TmuxArgvPlan;
  };
  readonly attach: TmuxArgvPlan;
  readonly detach: TmuxArgvPlan;
  readonly recover: {
    readonly existenceProbe: TmuxArgvPlan;
    readonly ownership: TmuxOutputGate;
    /** Attach may proceed only when this exact one-window topology matched. */
    readonly topology: TmuxOutputGate;
    readonly reconcile: readonly TmuxArgvPlan[];
    readonly attach: TmuxArgvPlan;
  };
  /** The executor may run `command` only when `ownership` matched exactly. */
  readonly cleanup: {
    readonly ownership: TmuxOutputGate;
    readonly command: TmuxArgvPlan;
  };
}

function tmux(argv: readonly string[]): TmuxArgvPlan {
  return { executable: "tmux", argv };
}

/**
 * Derived only from a UUID and a bounded collision generation. Semantic names
 * never become tmux session names or target syntax.
 */
export function groupedTmuxViewSessionName(attachmentId: string, generation: number): string {
  const parsed = GroupedTmuxAttachmentPlanInputSchemaZ.shape.attachmentId.parse(attachmentId);
  const parsedGeneration = z
    .number()
    .int()
    .min(0)
    .max(GROUPED_TMUX_MAX_GENERATION)
    .parse(generation);
  return `${GROUPED_TMUX_VIEW_SESSION_PREFIX}${parsed.replaceAll("-", "").toLowerCase()}-${parsedGeneration.toString(36)}`;
}

function markerValue(attachmentId: string, generation: number): string {
  return `v1:${attachmentId.toLowerCase()}:${generation}`;
}

function viewWindowTarget(viewSessionName: string, windowId: string): string {
  return `${viewSessionName}:${windowId}`;
}

function reconcileCommands(args: {
  viewSessionName: string;
  sourceWindowId: string;
}): readonly TmuxArgvPlan[] {
  const windowTarget = viewWindowTarget(args.viewSessionName, args.sourceWindowId);
  return [
    tmux(["select-window", "-t", windowTarget]),
    tmux(["set-option", "-t", args.viewSessionName, "status", "off"]),
    tmux(["set-option", "-t", args.viewSessionName, "destroy-unattached", "off"]),
  ];
}

function attachCommand(
  viewSessionName: string,
  viewerMode: TerminalAttachmentViewerMode,
): TmuxArgvPlan {
  const target = `=${viewSessionName}`;
  return viewerMode === "read-only"
    ? tmux(["attach-session", "-f", "read-only,ignore-size", "-t", target])
    : tmux(["attach-session", "-t", target]);
}

/**
 * Pure, execution-free plan for one isolated ephemeral view. tmux cannot
 * create an empty session, so the create chain starts one fixed sleeping
 * placeholder, marks the session, links only the authorized durable window,
 * and unlinks the placeholder. It never creates a session group: a grouped
 * session would expose every source window through next/previous navigation.
 *
 * The linked window's contents and window options are shared with the durable
 * source. This planner therefore mutates session-scoped view state only;
 * especially, read-only setup never writes `window-size` or resizes a window.
 */
export function planGroupedTmuxAttachment(
  input: GroupedTmuxAttachmentPlanInput,
): GroupedTmuxAttachmentPlan {
  const parsed = GroupedTmuxAttachmentPlanInputSchemaZ.parse(input);
  const viewSessionName = groupedTmuxViewSessionName(parsed.attachmentId, parsed.generation);
  const viewMarkerValue = markerValue(parsed.attachmentId, parsed.generation);
  const exactViewTarget = `=${viewSessionName}`;
  const existenceProbe = tmux(["has-session", "-t", exactViewTarget]);
  const ownership: TmuxOutputGate = {
    query: tmux(["show-environment", "-t", exactViewTarget, GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT]),
    expectedStdout: `${GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT}=${viewMarkerValue}`,
  };
  const topology: TmuxOutputGate = {
    query: tmux(["list-windows", "-t", exactViewTarget, "-F", "#{window_id}"]),
    expectedStdout: parsed.source.windowId,
  };
  const reconcile = reconcileCommands({
    viewSessionName,
    sourceWindowId: parsed.source.windowId,
  });
  const attach = attachCommand(viewSessionName, parsed.viewerMode);

  const createArgv = [
    "new-session",
    "-d",
    "-s",
    viewSessionName,
    "-n",
    GROUPED_TMUX_PLACEHOLDER_WINDOW,
    GROUPED_TMUX_PLACEHOLDER_COMMAND,
    ";",
    "set-environment",
    "-t",
    viewSessionName,
    GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
    viewMarkerValue,
    ";",
    "set-option",
    "-t",
    viewSessionName,
    "status",
    "off",
    ";",
    "set-option",
    "-t",
    viewSessionName,
    "destroy-unattached",
    "off",
    ";",
    "link-window",
    "-ad",
    "-s",
    `${parsed.source.sessionId}:${parsed.source.windowId}`,
    "-t",
    `${viewSessionName}:`,
    ";",
    "unlink-window",
    "-t",
    `${viewSessionName}:`,
  ];

  return {
    identity: {
      attachmentId: parsed.attachmentId,
      generation: parsed.generation,
      viewSessionName,
      markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
      markerValue: viewMarkerValue,
      semanticTarget: parsed.target,
      durableSource: {
        sessionId: parsed.source.sessionId,
        windowId: parsed.source.windowId,
        runtimePaneId: parsed.source.runtimePaneId,
      },
    },
    viewerMode: parsed.viewerMode,
    viewport: parsed.viewport,
    create: {
      absenceProbe: existenceProbe,
      command: tmux(createArgv),
    },
    attach,
    detach: tmux(["detach-client", "-s", exactViewTarget]),
    recover: {
      existenceProbe,
      ownership,
      topology,
      reconcile,
      attach,
    },
    cleanup: {
      ownership,
      command: tmux(["kill-session", "-t", exactViewTarget]),
    },
  };
}
