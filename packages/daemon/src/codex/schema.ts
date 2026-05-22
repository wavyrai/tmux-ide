import { z } from "zod";

import { CLIENT_METHODS } from "./methods.ts";

export type JsonObject = { readonly [key: string]: unknown };

export interface CodexInitializeRequest {
  readonly capabilities?: {
    readonly experimentalApi?: boolean;
    readonly optOutNotificationMethods?: ReadonlyArray<string> | null;
  } | null;
  readonly clientInfo: {
    readonly name: string;
    readonly title?: string | null;
    readonly version: string;
  };
}

export interface CodexInitializeResponse {
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
  readonly userAgent: string;
}

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

export interface NewConversationRequest {
  readonly approvalPolicy?: ApprovalPolicy | null;
  readonly approvalsReviewer?: "user" | "guardian_subagent" | null;
  readonly baseInstructions?: string | null;
  readonly config?: JsonObject | null;
  readonly cwd?: string | null;
  readonly developerInstructions?: string | null;
  readonly ephemeral?: boolean | null;
  readonly model?: string | null;
  readonly modelProvider?: string | null;
  readonly personality?: string | null;
  readonly sandbox?: SandboxMode | null;
  readonly serviceName?: string | null;
  readonly serviceTier?: string | null;
  readonly sessionStartSource?: string | null;
}

export interface NewConversationResponse {
  readonly approvalPolicy: string;
  readonly approvalsReviewer: "user" | "guardian_subagent";
  readonly cwd: string;
  readonly instructionSources?: ReadonlyArray<string>;
  readonly model: string;
  readonly modelProvider: string;
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly sandbox: unknown;
  readonly serviceTier?: string | null;
  readonly thread: ThreadSummary;
}

export type UserInput =
  | {
      readonly type: "text";
      readonly text: string;
      readonly text_elements?: ReadonlyArray<unknown>;
    }
  | { readonly type: "image"; readonly url: string }
  | { readonly type: "localImage"; readonly path: string }
  | { readonly type: "skill"; readonly name: string; readonly path: string }
  | { readonly type: "mention"; readonly name: string; readonly path: string };

export interface SendUserMessageRequest {
  readonly approvalPolicy?: ApprovalPolicy | null;
  readonly approvalsReviewer?: "user" | "guardian_subagent" | null;
  readonly cwd?: string | null;
  readonly effort?: ReasoningEffort | null;
  readonly input: ReadonlyArray<UserInput>;
  readonly model?: string | null;
  readonly outputSchema?: unknown;
  readonly personality?: string | null;
  readonly sandboxPolicy?: unknown;
  readonly serviceTier?: string | null;
  readonly summary?: ReasoningSummary | null;
  readonly threadId: string;
}

export interface SendUserMessageResponse {
  readonly turn: TurnSummary;
}

export interface InterruptRequest {
  readonly threadId: string;
  readonly turnId: string;
}

export interface ThreadSummary extends JsonObject {
  readonly id: string;
}

export interface TurnSummary extends JsonObject {
  readonly id: string;
  readonly status?: string;
}

export type ApplyPatchFileChange =
  | { readonly type: "add"; readonly content: string }
  | { readonly type: "delete"; readonly content: string }
  | { readonly type: "update"; readonly unified_diff: string; readonly move_path?: string | null };

export interface ApplyPatchApprovalRequest {
  readonly callId: string;
  readonly conversationId: string;
  readonly fileChanges: Record<string, ApplyPatchFileChange>;
  readonly grantRoot?: string | null;
  readonly reason?: string | null;
}

export type ApplyPatchApprovalDecision =
  | "approved"
  | "approved_for_session"
  | "denied"
  | "timed_out"
  | "abort"
  | {
      readonly approved_execpolicy_amendment: {
        readonly proposed_execpolicy_amendment: ReadonlyArray<string>;
      };
    }
  | {
      readonly network_policy_amendment: {
        readonly network_policy_amendment: {
          readonly action: "allow" | "deny";
          readonly host: string;
        };
      };
    };

export interface ApplyPatchApprovalResponse {
  readonly decision: ApplyPatchApprovalDecision;
}

export interface ChatgptAuthTokensRefreshRequest {
  readonly previousAccountId?: string | null;
  readonly reason: "unauthorized";
}

export interface ChatgptAuthTokensRefreshResponse {
  readonly accessToken: string;
  readonly chatgptAccountId: string;
  readonly chatgptPlanType?: string | null;
}

export type CodexAgentEvent =
  | {
      readonly method: typeof CLIENT_METHODS.item_agent_message_delta;
      readonly params: {
        readonly delta: string;
        readonly itemId: string;
        readonly threadId: string;
        readonly turnId: string;
      };
    }
  | {
      readonly method:
        | typeof CLIENT_METHODS.item_reasoning_summary_text_delta
        | typeof CLIENT_METHODS.item_reasoning_text_delta;
      readonly params: {
        readonly contentIndex?: number;
        readonly delta: string;
        readonly itemId: string;
        readonly summaryIndex?: number;
        readonly threadId: string;
        readonly turnId: string;
      };
    }
  | {
      readonly method: typeof CLIENT_METHODS.item_reasoning_summary_part_added;
      readonly params: {
        readonly itemId: string;
        readonly summaryIndex: number;
        readonly threadId: string;
        readonly turnId: string;
      };
    }
  | {
      readonly method: typeof CLIENT_METHODS.turn_started | typeof CLIENT_METHODS.turn_completed;
      readonly params: {
        readonly threadId: string;
        readonly turn: TurnSummary;
      };
    }
  | {
      readonly method: typeof CLIENT_METHODS.item_completed;
      readonly params: {
        readonly item: JsonObject;
        readonly threadId: string;
        readonly turnId: string;
      };
    }
  | {
      readonly method: typeof CLIENT_METHODS.error;
      readonly params: JsonObject;
    };

const JsonObjectZ: z.ZodType<JsonObject> = z.record(z.string(), z.unknown());

const ApplyPatchFileChangeZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), content: z.string() }),
  z.object({ type: z.literal("delete"), content: z.string() }),
  z.object({
    type: z.literal("update"),
    unified_diff: z.string(),
    move_path: z.string().nullable().optional(),
  }),
]);

export const ApplyPatchApprovalRequestZ = z.object({
  callId: z.string(),
  conversationId: z.string(),
  fileChanges: z.record(z.string(), ApplyPatchFileChangeZ),
  grantRoot: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
}) satisfies z.ZodType<ApplyPatchApprovalRequest>;

const ApplyPatchApprovalDecisionZ: z.ZodType<ApplyPatchApprovalDecision> = z.union([
  z.literal("approved"),
  z.literal("approved_for_session"),
  z.literal("denied"),
  z.literal("timed_out"),
  z.literal("abort"),
  z.object({
    approved_execpolicy_amendment: z.object({
      proposed_execpolicy_amendment: z.array(z.string()),
    }),
  }),
  z.object({
    network_policy_amendment: z.object({
      network_policy_amendment: z.object({
        action: z.enum(["allow", "deny"]),
        host: z.string(),
      }),
    }),
  }),
]);

export const ApplyPatchApprovalResponseZ = z.object({
  decision: ApplyPatchApprovalDecisionZ,
}) satisfies z.ZodType<ApplyPatchApprovalResponse>;

export const ChatgptAuthTokensRefreshRequestZ = z.object({
  previousAccountId: z.string().nullable().optional(),
  reason: z.literal("unauthorized"),
}) satisfies z.ZodType<ChatgptAuthTokensRefreshRequest>;

export const ChatgptAuthTokensRefreshResponseZ = z.object({
  accessToken: z.string(),
  chatgptAccountId: z.string(),
  chatgptPlanType: z.string().nullable().optional(),
}) satisfies z.ZodType<ChatgptAuthTokensRefreshResponse>;

const TurnSummaryZ = z
  .object({ id: z.string(), status: z.string().optional() })
  .catchall(z.unknown());
const AgentMessageDeltaZ = z.object({
  delta: z.string(),
  itemId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
});
const ReasoningTextDeltaZ = AgentMessageDeltaZ.extend({ contentIndex: z.number().int() });
const ReasoningSummaryTextDeltaZ = AgentMessageDeltaZ.extend({ summaryIndex: z.number().int() });
const ReasoningSummaryPartAddedZ = z.object({
  itemId: z.string(),
  summaryIndex: z.number().int(),
  threadId: z.string(),
  turnId: z.string(),
});
const TurnNotificationZ = z.object({ threadId: z.string(), turn: TurnSummaryZ });
const ItemCompletedZ = z.object({ item: JsonObjectZ, threadId: z.string(), turnId: z.string() });

export const CodexAgentEventZ = z.discriminatedUnion("method", [
  z.object({
    method: z.literal(CLIENT_METHODS.item_agent_message_delta),
    params: AgentMessageDeltaZ,
  }),
  z.object({
    method: z.literal(CLIENT_METHODS.item_reasoning_summary_text_delta),
    params: ReasoningSummaryTextDeltaZ,
  }),
  z.object({
    method: z.literal(CLIENT_METHODS.item_reasoning_text_delta),
    params: ReasoningTextDeltaZ,
  }),
  z.object({
    method: z.literal(CLIENT_METHODS.item_reasoning_summary_part_added),
    params: ReasoningSummaryPartAddedZ,
  }),
  z.object({ method: z.literal(CLIENT_METHODS.turn_started), params: TurnNotificationZ }),
  z.object({ method: z.literal(CLIENT_METHODS.turn_completed), params: TurnNotificationZ }),
  z.object({ method: z.literal(CLIENT_METHODS.item_completed), params: ItemCompletedZ }),
  z.object({ method: z.literal(CLIENT_METHODS.error), params: JsonObjectZ }),
]) satisfies z.ZodType<CodexAgentEvent>;

export function defaultInitializeRequest(): CodexInitializeRequest {
  return {
    clientInfo: { name: "tmux-ide", title: "tmux-ide", version: "0.0.1" },
    capabilities: { experimentalApi: true, optOutNotificationMethods: null },
  };
}
