import { z } from "zod";

export type AgentProvider =
  | { kind: "claude-code"; binary?: string; model?: string }
  | { kind: "codex"; binary?: string; model?: string }
  | { kind: "gemini"; binary?: string; model?: string }
  | {
      kind: "custom";
      command: string;
      args: string[];
      env?: Record<string, string>;
      model?: string;
    };

export type JsonObject = { readonly [key: string]: unknown };
export type Meta = Record<string, unknown> | null;
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type PlanEntryStatus = "pending" | "in_progress" | "completed";
export type PlanEntryPriority = "high" | "medium" | "low";
export type SessionModeId = string;

export interface Implementation {
  readonly _meta?: Meta;
  readonly name: string;
  readonly title?: string | null;
  readonly version: string;
}

export type EmbeddedResourceResource =
  | {
      readonly _meta?: Meta;
      readonly mimeType?: string | null;
      readonly text: string;
      readonly uri: string;
    }
  | {
      readonly _meta?: Meta;
      readonly blob: string;
      readonly mimeType?: string | null;
      readonly uri: string;
    };

export type ContentBlock =
  | ({
      readonly type: "text";
      readonly _meta?: Meta;
      readonly annotations?: unknown;
      readonly text: string;
    } & JsonObject)
  | ({
      readonly type: "image";
      readonly _meta?: Meta;
      readonly annotations?: unknown;
      readonly data: string;
      readonly mimeType: string;
      readonly uri?: string | null;
    } & JsonObject)
  | ({
      readonly type: "audio";
      readonly _meta?: Meta;
      readonly annotations?: unknown;
      readonly data: string;
      readonly mimeType: string;
    } & JsonObject)
  | ({
      readonly type: "resource";
      readonly _meta?: Meta;
      readonly annotations?: unknown;
      readonly resource: EmbeddedResourceResource;
    } & JsonObject)
  | ({
      readonly type: "resource_link";
      readonly _meta?: Meta;
      readonly annotations?: unknown;
      readonly description?: string | null;
      readonly mimeType?: string | null;
      readonly name: string;
      readonly size?: number | null;
      readonly title?: string | null;
      readonly uri: string;
    } & JsonObject);

export interface ToolCallLocation {
  readonly _meta?: Meta;
  readonly line?: number | null;
  readonly path: string;
}

export type ToolCallContent =
  | ({
      readonly type: "content";
      readonly _meta?: Meta;
      readonly content: ContentBlock;
    } & JsonObject)
  | ({
      readonly type: "diff";
      readonly _meta?: Meta;
      readonly newText: string;
      readonly oldText?: string | null;
      readonly path: string;
    } & JsonObject)
  | ({
      readonly type: "terminal";
      readonly _meta?: Meta;
      readonly terminalId: string;
    } & JsonObject);

export interface ToolCall {
  readonly _meta?: Meta;
  readonly content?: ReadonlyArray<ToolCallContent>;
  readonly kind?: ToolKind;
  readonly locations?: ReadonlyArray<ToolCallLocation>;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly status?: ToolCallStatus;
  readonly title: string;
  readonly toolCallId: string;
}

export interface ToolCallUpdate {
  readonly _meta?: Meta;
  readonly content?: ReadonlyArray<ToolCallContent> | null;
  readonly kind?: ToolKind | null;
  readonly locations?: ReadonlyArray<ToolCallLocation> | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly status?: ToolCallStatus | null;
  readonly title?: string | null;
  readonly toolCallId: string;
}

export interface PlanEntry {
  readonly _meta?: Meta;
  readonly content: string;
  readonly priority: PlanEntryPriority;
  readonly status: PlanEntryStatus;
}

export interface AgentPlanUpdate {
  readonly _meta?: Meta;
  readonly entries: ReadonlyArray<PlanEntry>;
}

export interface AvailableCommandInput {
  readonly _meta?: Meta;
  readonly hint: string;
}

export interface AvailableCommand {
  readonly _meta?: Meta;
  readonly description: string;
  readonly input?: AvailableCommandInput | null;
  readonly name: string;
}

export interface AvailableCommandsUpdate {
  readonly _meta?: Meta;
  readonly availableCommands: ReadonlyArray<AvailableCommand>;
}

export interface SessionMode {
  readonly _meta?: Meta;
  readonly description?: string | null;
  readonly id: SessionModeId;
  readonly name: string;
}

export interface SessionModeState {
  readonly _meta?: Meta;
  readonly currentModeId: SessionModeId;
  readonly availableModes: ReadonlyArray<SessionMode>;
}

export interface AgentMessageChunk extends JsonObject {
  readonly sessionUpdate: "agent_message_chunk";
  readonly _meta?: Meta;
  readonly content: ContentBlock;
  readonly messageId?: string | null;
}

export interface AgentThoughtChunk extends JsonObject {
  readonly sessionUpdate: "agent_thought_chunk";
  readonly _meta?: Meta;
  readonly content: ContentBlock;
  readonly messageId?: string | null;
}

export interface UserMessageChunk extends JsonObject {
  readonly sessionUpdate: "user_message_chunk";
  readonly _meta?: Meta;
  readonly content: ContentBlock;
  readonly messageId?: string | null;
}

export type SessionUpdate =
  | (UserMessageChunk & JsonObject)
  | (AgentMessageChunk & JsonObject)
  | (AgentThoughtChunk & JsonObject)
  | ({ readonly sessionUpdate: "tool_call" } & ToolCall & JsonObject)
  | ({ readonly sessionUpdate: "tool_call_update" } & ToolCallUpdate & JsonObject)
  | ({ readonly sessionUpdate: "plan" } & AgentPlanUpdate & JsonObject)
  | ({ readonly sessionUpdate: "available_commands_update" } & AvailableCommandsUpdate & JsonObject)
  | ({
      readonly sessionUpdate: "current_mode_update";
      readonly _meta?: Meta;
      readonly currentModeId: SessionModeId;
    } & JsonObject)
  | ({
      readonly sessionUpdate: "config_option_update";
      readonly _meta?: Meta;
      readonly configOptions: ReadonlyArray<unknown>;
    } & JsonObject)
  | ({
      readonly sessionUpdate: "session_info_update";
      readonly _meta?: Meta;
      readonly title?: string | null;
      readonly updatedAt?: string | null;
    } & JsonObject)
  | ({
      readonly sessionUpdate: "usage_update";
      readonly _meta?: Meta;
      readonly cost?: unknown;
      readonly size: number;
      readonly used: number;
    } & JsonObject);

export interface SessionNotification {
  readonly _meta?: Meta;
  readonly sessionId: string;
  readonly update: SessionUpdate;
}

export interface InitializeRequest {
  readonly _meta?: Meta;
  readonly clientCapabilities?: Record<string, unknown>;
  readonly clientInfo?: Implementation | null;
  readonly protocolVersion: number;
}

export interface InitializeResponse {
  readonly _meta?: Meta;
  readonly agentCapabilities?: Record<string, unknown>;
  readonly agentInfo?: Implementation | null;
  readonly authMethods?: ReadonlyArray<unknown>;
  readonly protocolVersion: number;
}

export type McpServer =
  | {
      readonly type: "http";
      readonly _meta?: Meta;
      readonly headers: ReadonlyArray<unknown>;
      readonly name: string;
      readonly url: string;
    }
  | {
      readonly type: "sse";
      readonly _meta?: Meta;
      readonly headers: ReadonlyArray<unknown>;
      readonly name: string;
      readonly url: string;
    }
  | {
      readonly _meta?: Meta;
      readonly args: ReadonlyArray<string>;
      readonly command: string;
      readonly env: ReadonlyArray<unknown>;
      readonly name: string;
    };

export interface NewSessionRequest {
  readonly _meta?: Meta;
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<McpServer>;
}

export interface NewSessionResponse {
  readonly _meta?: Meta;
  readonly configOptions?: ReadonlyArray<unknown> | null;
  readonly models?: unknown;
  readonly modes?: SessionModeState | null;
  readonly sessionId: string;
}

export interface LoadSessionRequest {
  readonly _meta?: Meta;
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<McpServer>;
  readonly sessionId: string;
}

export interface LoadSessionResponse {
  readonly _meta?: Meta;
  readonly configOptions?: ReadonlyArray<unknown> | null;
  readonly models?: unknown;
  readonly modes?: SessionModeState | null;
}

export interface PromptRequest {
  readonly _meta?: Meta;
  readonly messageId?: string | null;
  readonly prompt: ReadonlyArray<ContentBlock>;
  readonly sessionId: string;
}

export interface PromptResponse {
  readonly _meta?: Meta;
  readonly stopReason: StopReason;
  readonly usage?: unknown;
  readonly userMessageId?: string | null;
}

export interface CancelNotification {
  readonly _meta?: Meta;
  readonly sessionId: string;
}

export type PermissionOption = {
  readonly _meta?: Meta;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  readonly name: string;
  readonly optionId: string;
};

export interface RequestPermissionRequest {
  readonly _meta?: Meta;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly sessionId: string;
  readonly toolCall: ToolCallUpdate;
}

export interface RequestPermissionResponse {
  readonly _meta?: Meta;
  readonly outcome:
    | { readonly outcome: "cancelled" }
    | { readonly outcome: "selected"; readonly _meta?: Meta; readonly optionId: string };
}

const MetaZ = z.record(z.string(), z.unknown()).nullable().optional();
const EmbeddedResourceResourceZ = z.union([
  z.object({
    _meta: MetaZ,
    mimeType: z.string().nullable().optional(),
    text: z.string(),
    uri: z.string(),
  }),
  z.object({
    _meta: MetaZ,
    blob: z.string(),
    mimeType: z.string().nullable().optional(),
    uri: z.string(),
  }),
]) as unknown as z.ZodType<EmbeddedResourceResource>;
const ContentBlockZ = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    _meta: MetaZ,
    annotations: z.unknown().optional(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    _meta: MetaZ,
    annotations: z.unknown().optional(),
    data: z.string(),
    mimeType: z.string(),
    uri: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("audio"),
    _meta: MetaZ,
    annotations: z.unknown().optional(),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal("resource"),
    _meta: MetaZ,
    annotations: z.unknown().optional(),
    resource: EmbeddedResourceResourceZ,
  }),
  z.object({
    type: z.literal("resource_link"),
    _meta: MetaZ,
    annotations: z.unknown().optional(),
    description: z.string().nullable().optional(),
    mimeType: z.string().nullable().optional(),
    name: z.string(),
    size: z.number().int().nullable().optional(),
    title: z.string().nullable().optional(),
    uri: z.string(),
  }),
]) as unknown as z.ZodType<ContentBlock>;

const ToolKindZ = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
const ToolCallStatusZ = z.enum(["pending", "in_progress", "completed", "failed"]);
const ToolCallLocationZ = z.object({
  _meta: MetaZ,
  line: z.number().int().nullable().optional(),
  path: z.string(),
}) as unknown as z.ZodType<ToolCallLocation>;
const ToolCallContentZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), _meta: MetaZ, content: ContentBlockZ }),
  z.object({
    type: z.literal("diff"),
    _meta: MetaZ,
    newText: z.string(),
    oldText: z.string().nullable().optional(),
    path: z.string(),
  }),
  z.object({ type: z.literal("terminal"), _meta: MetaZ, terminalId: z.string() }),
]) as unknown as z.ZodType<ToolCallContent>;
const PermissionOptionZ = z.object({
  _meta: MetaZ,
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
  name: z.string(),
  optionId: z.string(),
}) as unknown as z.ZodType<PermissionOption>;
const ToolCallUpdateRawZ = z.object({
  _meta: MetaZ,
  content: z.array(ToolCallContentZ).nullable().optional(),
  kind: ToolKindZ.nullable().optional(),
  locations: z.array(ToolCallLocationZ).nullable().optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  status: ToolCallStatusZ.nullable().optional(),
  title: z.string().nullable().optional(),
  toolCallId: z.string(),
});
const ToolCallUpdateZ = ToolCallUpdateRawZ as unknown as z.ZodType<ToolCallUpdate>;
const PlanEntryZ = z.object({
  _meta: MetaZ,
  content: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"]),
}) as unknown as z.ZodType<PlanEntry>;
const AvailableCommandInputZ = z.object({
  _meta: MetaZ,
  hint: z.string(),
}) as unknown as z.ZodType<AvailableCommandInput>;
const AvailableCommandZ = z.object({
  _meta: MetaZ,
  description: z.string(),
  input: AvailableCommandInputZ.nullable().optional(),
  name: z.string(),
}) as unknown as z.ZodType<AvailableCommand>;

export const RequestPermissionRequestZ: z.ZodType<RequestPermissionRequest> = z.object({
  _meta: MetaZ,
  options: z.array(PermissionOptionZ),
  sessionId: z.string(),
  toolCall: ToolCallUpdateZ,
});

export const SessionNotificationZ: z.ZodType<SessionNotification> = z.object({
  _meta: MetaZ,
  sessionId: z.string(),
  update: z.discriminatedUnion("sessionUpdate", [
    z.object({
      sessionUpdate: z.literal("user_message_chunk"),
      _meta: MetaZ,
      content: ContentBlockZ,
      messageId: z.string().nullable().optional(),
    }),
    z.object({
      sessionUpdate: z.literal("agent_message_chunk"),
      _meta: MetaZ,
      content: ContentBlockZ,
      messageId: z.string().nullable().optional(),
    }),
    z.object({
      sessionUpdate: z.literal("agent_thought_chunk"),
      _meta: MetaZ,
      content: ContentBlockZ,
      messageId: z.string().nullable().optional(),
    }),
    z.object({
      sessionUpdate: z.literal("tool_call"),
      _meta: MetaZ,
      content: z.array(ToolCallContentZ).optional(),
      kind: ToolKindZ.optional(),
      locations: z.array(ToolCallLocationZ).optional(),
      rawInput: z.unknown().optional(),
      rawOutput: z.unknown().optional(),
      status: ToolCallStatusZ.optional(),
      title: z.string(),
      toolCallId: z.string(),
    }),
    ToolCallUpdateRawZ.extend({ sessionUpdate: z.literal("tool_call_update") }),
    z.object({
      sessionUpdate: z.literal("plan"),
      _meta: MetaZ,
      entries: z.array(PlanEntryZ),
    }),
    z.object({
      sessionUpdate: z.literal("available_commands_update"),
      _meta: MetaZ,
      availableCommands: z.array(AvailableCommandZ),
    }),
    z.object({
      sessionUpdate: z.literal("current_mode_update"),
      _meta: MetaZ,
      currentModeId: z.string(),
    }),
    z.object({
      sessionUpdate: z.literal("config_option_update"),
      _meta: MetaZ,
      configOptions: z.array(z.unknown()),
    }),
    z.object({
      sessionUpdate: z.literal("session_info_update"),
      _meta: MetaZ,
      title: z.string().nullable().optional(),
      updatedAt: z.string().nullable().optional(),
    }),
    z.object({
      sessionUpdate: z.literal("usage_update"),
      _meta: MetaZ,
      cost: z.unknown().optional(),
      size: z.number().int().nonnegative(),
      used: z.number().int().nonnegative(),
    }),
  ]),
});
