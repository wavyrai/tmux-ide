import { z } from "zod";
import type {
  BorderTokenRole,
  SelectionTokenRole,
  StatusToneRole,
  SurfaceTokenRole,
  TextTokenRole,
} from "./visual-tokens.ts";

export const SemanticProductIdSchemaZ = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "semantic id contains a transport-only character");
export type SemanticProductId = z.infer<typeof SemanticProductIdSchemaZ>;

export const PaneStructureSchemaZ = z.enum(["docked", "floating", "maximized"]);
export const AgentActivitySchemaZ = z.enum([
  "idle",
  "running",
  "waiting",
  "complete",
  "failed",
  "disconnected",
]);
export const CanonicalDomainStatusSchemaZ = z.enum([
  "idle",
  "running",
  "blocked",
  "review",
  "done",
  "disconnected",
  "recovering",
]);
export const PaneAttentionSchemaZ = z.enum([
  "none",
  "unread",
  "requested",
  "warning",
  "destructive",
  "recovery",
]);
export type PaneStructure = z.infer<typeof PaneStructureSchemaZ>;
export type AgentActivity = z.infer<typeof AgentActivitySchemaZ>;
export type CanonicalDomainStatus = z.infer<typeof CanonicalDomainStatusSchemaZ>;
export type PaneAttention = z.infer<typeof PaneAttentionSchemaZ>;

export const PaneVisualStateV1SchemaZ = z
  .object({
    structure: PaneStructureSchemaZ,
    applicationFocus: z
      .object({ pane: z.boolean(), terminalInput: z.boolean(), windowActive: z.boolean() })
      .strict(),
    agentActivity: AgentActivitySchemaZ,
    domainStatus: CanonicalDomainStatusSchemaZ,
    attention: PaneAttentionSchemaZ,
    layoutInteraction: z
      .object({
        editable: z.boolean(),
        selected: z.boolean(),
        dragging: z.boolean(),
        resizing: z.boolean(),
        previewing: z.boolean(),
      })
      .strict(),
    controlInteraction: z
      .object({
        hover: z.boolean(),
        focusVisible: z.boolean(),
        pressed: z.boolean(),
        disabled: z.boolean(),
        loading: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PaneVisualStateV1 = z.infer<typeof PaneVisualStateV1SchemaZ>;

const DOMAIN_STATUS_TONES: Readonly<Record<CanonicalDomainStatus, StatusToneRole>> = Object.freeze({
  idle: "neutral",
  running: "info",
  blocked: "warning",
  review: "info",
  done: "success",
  disconnected: "danger",
  recovering: "danger",
});

export function statusToneForDomainStatus(status: CanonicalDomainStatus): StatusToneRole {
  return DOMAIN_STATUS_TONES[status];
}

function toneForAttention(attention: PaneAttention): StatusToneRole | null {
  switch (attention) {
    case "none":
      return null;
    case "unread":
    case "requested":
      return "info";
    case "warning":
      return "warning";
    case "destructive":
    case "recovery":
      return "danger";
  }
}

export interface PaneAppearance {
  readonly structure: PaneStructure;
  readonly header: {
    readonly surface: SurfaceTokenRole;
    readonly text: TextTokenRole;
    readonly focused: boolean;
    readonly windowActive: boolean;
    readonly agentActivity: AgentActivity;
    readonly attention: PaneAttention;
  };
  readonly border: {
    readonly role: BorderTokenRole;
    readonly strength: "quiet" | "default" | "decisive";
    readonly ownsApplicationFocus: boolean;
  };
  readonly outerOutline: {
    readonly visible: boolean;
    readonly role: BorderTokenRole | null;
    readonly intent: "layout-selection" | null;
  };
  readonly status: {
    readonly domainStatus: CanonicalDomainStatus;
    readonly domainTone: StatusToneRole;
    readonly attentionTone: StatusToneRole | null;
    readonly tone: StatusToneRole;
    readonly attention: PaneAttention;
  };
  readonly action: {
    readonly background: SelectionTokenRole | null;
    readonly focusOutline: BorderTokenRole | null;
    readonly hover: boolean;
    readonly focusVisible: boolean;
    readonly pressed: boolean;
    readonly disabled: boolean;
    readonly loading: boolean;
    readonly interactive: boolean;
  };
  readonly accessibility: {
    readonly focused: boolean;
    readonly terminalInputOwner: boolean;
    readonly layoutSelected: boolean;
    readonly hasAttention: boolean;
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly description: string;
  };
}

function borderForState(state: PaneVisualStateV1): PaneAppearance["border"] {
  if (state.applicationFocus.pane && state.applicationFocus.windowActive) {
    return { role: "focused", strength: "decisive", ownsApplicationFocus: true };
  }
  const attentionTone = toneForAttention(state.attention);
  if (attentionTone === "danger") {
    return { role: "danger", strength: "decisive", ownsApplicationFocus: false };
  }
  if (attentionTone === "warning") {
    return { role: "attention", strength: "decisive", ownsApplicationFocus: false };
  }
  return {
    role: state.structure === "docked" ? "subtle" : "default",
    strength: state.structure === "docked" ? "quiet" : "default",
    ownsApplicationFocus: false,
  };
}

function actionBackground(state: PaneVisualStateV1): SelectionTokenRole | null {
  if (state.controlInteraction.disabled) return "disabled";
  if (state.controlInteraction.pressed) return "pressed";
  if (state.controlInteraction.hover) return "hover";
  return null;
}

function stateDescription(state: PaneVisualStateV1): string {
  const parts = [
    `${state.structure} pane`,
    `${state.domainStatus} status`,
    `${state.agentActivity} agent`,
  ];
  if (state.applicationFocus.pane) parts.push("application focus");
  if (state.applicationFocus.terminalInput) parts.push("terminal input owner");
  if (state.layoutInteraction.selected) parts.push("selected for layout editing");
  if (state.attention !== "none") parts.push(`${state.attention} attention`);
  if (state.controlInteraction.loading) parts.push("loading");
  if (state.controlInteraction.disabled) parts.push("controls disabled");
  return parts.join(", ");
}

/** One pure composition pass produces every visual slot for one renderer frame. */
export function resolvePaneAppearance(state: PaneVisualStateV1): PaneAppearance {
  const parsed = PaneVisualStateV1SchemaZ.parse(state);
  const domainTone = statusToneForDomainStatus(parsed.domainStatus);
  const attentionTone = toneForAttention(parsed.attention);
  const selected = parsed.layoutInteraction.selected;
  return {
    structure: parsed.structure,
    header: {
      surface:
        parsed.applicationFocus.pane && parsed.applicationFocus.windowActive
          ? "headerActive"
          : "header",
      text: parsed.applicationFocus.windowActive ? "primary" : "muted",
      focused: parsed.applicationFocus.pane,
      windowActive: parsed.applicationFocus.windowActive,
      agentActivity: parsed.agentActivity,
      attention: parsed.attention,
    },
    border: borderForState(parsed),
    outerOutline: {
      visible: selected,
      role: selected ? "selected" : null,
      intent: selected ? "layout-selection" : null,
    },
    status: {
      domainStatus: parsed.domainStatus,
      domainTone,
      attentionTone,
      tone: attentionTone ?? domainTone,
      attention: parsed.attention,
    },
    action: {
      background: actionBackground(parsed),
      focusOutline: parsed.controlInteraction.focusVisible ? "focused" : null,
      ...parsed.controlInteraction,
      interactive: !parsed.controlInteraction.disabled && !parsed.controlInteraction.loading,
    },
    accessibility: {
      focused: parsed.applicationFocus.pane,
      terminalInputOwner: parsed.applicationFocus.terminalInput,
      layoutSelected: selected,
      hasAttention: parsed.attention !== "none",
      busy: parsed.controlInteraction.loading,
      disabled: parsed.controlInteraction.disabled,
      description: stateDescription(parsed),
    },
  };
}
