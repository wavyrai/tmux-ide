import { z } from "zod";
import { TerminalAttachmentSemanticWindowIdSchemaZ } from "./semantic-identity.ts";
import { WorkspaceCatalogLiveSessionIdSchemaZ } from "./workspace-catalog-resource.ts";

/** Schema bound, not a measured runtime resource budget. */
export const WINDOW_LINK_MAX_LINKS = 256;

/** Random daemon/session-generation-scoped handle; never a native index or ID. */
export const WindowLinkIdSchemaZ = z.string().regex(/^window-link\.[a-f0-9]{32}$/u);
export const WindowLinkRevisionSchemaZ = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** Shape validation only: the authority must validate session, revision and backing. */
export const WindowLinkTargetSchemaZ = z
  .object({
    liveSessionId: WorkspaceCatalogLiveSessionIdSchemaZ,
    linkId: WindowLinkIdSchemaZ,
    expectedSemanticWindowId: TerminalAttachmentSemanticWindowIdSchemaZ,
    linkRevision: WindowLinkRevisionSchemaZ,
  })
  .strict();

export const WindowLinkObservationSchemaZ = z
  .object({
    linkId: WindowLinkIdSchemaZ,
    semanticWindowId: TerminalAttachmentSemanticWindowIdSchemaZ,
    /** Display only. Mutations resolve the opaque handle under live authority. */
    displayIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const WindowLinkTopologySchemaZ = z
  .object({
    liveSessionId: WorkspaceCatalogLiveSessionIdSchemaZ,
    linkRevision: WindowLinkRevisionSchemaZ,
    activeLinkId: WindowLinkIdSchemaZ,
    links: z.array(WindowLinkObservationSchemaZ).min(1).max(WINDOW_LINK_MAX_LINKS),
  })
  .strict()
  .superRefine((topology, context) => {
    const ids = new Set<string>();
    const indexes = new Set<number>();
    for (const [index, link] of topology.links.entries()) {
      if (ids.has(link.linkId)) {
        context.addIssue({
          code: "custom",
          message: "Window link handles must be unique",
          path: ["links", index, "linkId"],
        });
      }
      if (indexes.has(link.displayIndex)) {
        context.addIssue({
          code: "custom",
          message: "Window link display indexes must be unique",
          path: ["links", index, "displayIndex"],
        });
      }
      ids.add(link.linkId);
      indexes.add(link.displayIndex);
    }
    if (!ids.has(topology.activeLinkId)) {
      context.addIssue({
        code: "custom",
        message: "The active window link must be present",
        path: ["activeLinkId"],
      });
    }
  });

export type WindowLinkId = z.infer<typeof WindowLinkIdSchemaZ>;
export type WindowLinkTarget = z.infer<typeof WindowLinkTargetSchemaZ>;
export type WindowLinkObservation = z.infer<typeof WindowLinkObservationSchemaZ>;
export type WindowLinkTopology = z.infer<typeof WindowLinkTopologySchemaZ>;
