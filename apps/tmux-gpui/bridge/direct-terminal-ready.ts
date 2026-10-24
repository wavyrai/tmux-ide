import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "../../../packages/contracts/src/semantic-identity.ts";
import { topologySchema, type Layout } from "./topology.ts";
import type { OwnerActionBinding } from "./direct-owner-actions.ts";
/** Trusted Rust acknowledgement of coherent native paint/input scope; never carries cells. */
export const nativeTerminalReadySchema = z
  .object({
    type: z.literal("native-terminal-ready"),
    version: z.literal(1),
    id: z.uuid(),
    request: z.number().int().nonnegative().safe(),
    pane: TerminalAttachmentSemanticPaneIdSchemaZ,
    liveSessionId: z.string().min(1).max(512),
    generation: z.uuid(),
    presenceRevision: z.number().int().nonnegative().safe(),
    inputReady: z.literal(true),
    coherent: z.literal(true),
  })
  .strict();
export function acceptsNativeReady(
  binding: OwnerActionBinding | null,
  value: unknown,
  presenceRevision: number,
): boolean {
  const parsed = nativeTerminalReadySchema.safeParse(value);
  if (!binding || binding.catalogOnly || !parsed.success) return false;
  const event = parsed.data;
  return (
    event.id === binding.id &&
    event.request === binding.request &&
    event.pane === binding.config.semanticPaneId &&
    event.liveSessionId === binding.config.liveSessionId &&
    event.generation === binding.config.scope.generation &&
    event.presenceRevision === presenceRevision
  );
}

export const nativeTerminalCatalogSchema = z
  .object({
    type: z.literal("native-terminal-catalog"),
    version: z.literal(1),
    id: z.uuid(),
    request: z.number().int().nonnegative().safe(),
    pane: TerminalAttachmentSemanticPaneIdSchemaZ,
    liveSessionId: z.string().min(1).max(512),
    generation: z.uuid(),
    presenceRevision: z.number().int().nonnegative().safe(),
    layouts: topologySchema,
  })
  .strict();
export function acceptNativeCatalog(
  binding: OwnerActionBinding | null,
  value: unknown,
  presenceRevision: number,
): Layout[] | null {
  const parsed = nativeTerminalCatalogSchema.safeParse(value);
  if (!binding || !parsed.success) return null;
  const event = parsed.data;
  if (
    event.id !== binding.id ||
    event.request !== binding.request ||
    event.pane !== binding.config.semanticPaneId ||
    event.liveSessionId !== binding.config.liveSessionId ||
    event.generation !== binding.config.scope.generation ||
    event.presenceRevision !== presenceRevision
  )
    return null;
  const issued = new Set(binding.config.visiblePaneIds ?? [binding.config.semanticPaneId]);
  const ids = event.layouts.flatMap((layout) =>
    layout.panes.map((pane) => pane.pane).filter((pane): pane is string => !!pane),
  );
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== issued.size ||
    ids.some((id) => !issued.has(id))
  )
    return null;
  return event.layouts;
}

/** A failed native socket can ask the existing bounded recovery owner to refresh.
 * Exact attachment identity prevents a retired socket from reviving another pane.
 */
export const nativeTerminalInterruptedSchema = nativeTerminalReadySchema
  .omit({ inputReady: true, coherent: true })
  .extend({ type: z.literal("native-terminal-interrupted") });
export function acceptsNativeInterrupted(
  binding: OwnerActionBinding | null,
  value: unknown,
  presenceRevision: number,
): boolean {
  const parsed = nativeTerminalInterruptedSchema.safeParse(value);
  if (!parsed.success) return false;
  return acceptsNativeReady(
    binding,
    {
      ...parsed.data,
      type: "native-terminal-ready",
      inputReady: true,
      coherent: true,
    },
    presenceRevision,
  );
}
