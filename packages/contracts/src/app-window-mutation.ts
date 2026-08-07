import { z } from "zod";

import { AppWindowIdSchemaZ, AppWindowRectSchemaZ } from "./app-window-state.ts";
import {
  DesktopDaemonCapabilityErrorSchemaZ,
  DesktopWorkspaceNameSchemaZ,
} from "./desktop-host.ts";

/** Renderer-authored semantic mutation. Runtime paths and tmux identities are excluded. */
export const AppWindowMutationCommandSchemaZ = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("window.focus"),
      windowId: AppWindowIdSchemaZ.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("window.float"),
      windowId: AppWindowIdSchemaZ,
      rect: AppWindowRectSchemaZ.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("window.move"),
      windowId: AppWindowIdSchemaZ,
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal("window.resize"),
      windowId: AppWindowIdSchemaZ,
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("window.dock"),
      windowId: AppWindowIdSchemaZ,
      stackId: AppWindowIdSchemaZ.optional(),
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("stack.activate"),
      stackId: AppWindowIdSchemaZ,
      windowId: AppWindowIdSchemaZ,
    })
    .strict(),
]);

export type AppWindowMutationCommand = z.infer<typeof AppWindowMutationCommandSchemaZ>;

export const AppWindowMutationArgumentsSchemaZ = z
  .object({
    workspaceName: DesktopWorkspaceNameSchemaZ,
    expectedDocumentRevision: z.number().int().nonnegative(),
    command: AppWindowMutationCommandSchemaZ,
  })
  .strict();

export type AppWindowMutationArguments = z.infer<typeof AppWindowMutationArgumentsSchemaZ>;

/** Main-process-authored retry and daemon-generation envelope. */
export const AppWindowMutationRequestSchemaZ = z
  .object({
    operationId: z.uuid(),
    expectedDaemonInstanceId: z.uuid(),
    intent: AppWindowMutationArgumentsSchemaZ,
  })
  .strict();

export type AppWindowMutationRequest = z.infer<typeof AppWindowMutationRequestSchemaZ>;

export const AppWindowMutationResultSchemaZ = z
  .object({
    operationId: z.uuid(),
    daemonInstanceId: z.uuid(),
    outcome: z.enum(["applied", "unchanged", "replayed"]),
    workspaceName: DesktopWorkspaceNameSchemaZ,
    documentRevision: z.number().int().nonnegative(),
  })
  .strict();

export type AppWindowMutationResult = z.infer<typeof AppWindowMutationResultSchemaZ>;

export const AppWindowMutationHostResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), result: AppWindowMutationResultSchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);

export type AppWindowMutationHostResult = z.infer<typeof AppWindowMutationHostResultSchemaZ>;
