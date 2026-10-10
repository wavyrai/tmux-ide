import { z } from "zod";
import { WindowLinkTargetSchemaZ } from "./window-links.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";

const dimension = z.number().int().min(1).max(4096);
const coordinate = z.number().int().min(0).max(4095);
const boundary = z.number().int().min(0).max(4096);

/** Opt-in semantic projection. Native tree identifiers and paths never cross this boundary. */
export const WindowSplitLayoutResourceSchemaZ = z
  .object({
    version: z.literal(1),
    window: WindowLinkTargetSchemaZ,
    layoutId: z.uuid(),
    cols: dimension,
    rows: dimension,
    panes: z
      .array(
        z
          .object({
            semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
            left: coordinate,
            top: coordinate,
            width: dimension,
            height: dimension,
          })
          .strict(),
      )
      .min(1)
      .max(256),
    splits: z
      .array(
        z
          .object({
            splitId: z.uuid(),
            axis: z.enum(["cols", "rows"]),
            boundary,
            start: coordinate,
            length: dimension,
          })
          .strict(),
      )
      .max(255),
  })
  .strict()
  .superRefine((resource, context) => {
    const panes = new Set<string>();
    for (const [index, pane] of resource.panes.entries()) {
      if (panes.has(pane.semanticPaneId))
        context.addIssue({
          code: "custom",
          path: ["panes", index, "semanticPaneId"],
          message: "Pane identities must be unique",
        });
      panes.add(pane.semanticPaneId);
      if (pane.left + pane.width > resource.cols || pane.top + pane.height > resource.rows)
        context.addIssue({
          code: "custom",
          path: ["panes", index],
          message: "Pane rectangle exceeds the window",
        });
    }
    const splits = new Set<string>();
    for (const [index, split] of resource.splits.entries()) {
      if (splits.has(split.splitId))
        context.addIssue({
          code: "custom",
          path: ["splits", index, "splitId"],
          message: "Split identities must be unique",
        });
      splits.add(split.splitId);
      const limit = split.axis === "cols" ? resource.cols : resource.rows;
      const cross = split.axis === "cols" ? resource.rows : resource.cols;
      if (split.boundary <= 0 || split.boundary >= limit)
        context.addIssue({
          code: "custom",
          path: ["splits", index, "boundary"],
          message: "Split boundary must be interior",
        });
      if (split.start + split.length > cross)
        context.addIssue({
          code: "custom",
          path: ["splits", index],
          message: "Split span exceeds the window",
        });
    }
  });

/** Desired boundary may reach either endpoint; the native owner clamps valid requests. */
export const WindowSplitResizeTargetSchemaZ = z
  .object({
    window: WindowLinkTargetSchemaZ,
    layoutId: z.uuid(),
    splitId: z.uuid(),
    boundary,
  })
  .strict();
export type WindowSplitLayoutResource = z.infer<typeof WindowSplitLayoutResourceSchemaZ>;
export type WindowSplitResizeTarget = z.infer<typeof WindowSplitResizeTargetSchemaZ>;

/** Canonical post-mutation resource and the matching surviving split handle. */
export const WindowSplitSuccessorSchemaZ = z
  .object({
    resource: WindowSplitLayoutResourceSchemaZ,
    splitId: z.uuid(),
  })
  .strict()
  .superRefine((successor, context) => {
    if (!successor.resource.splits.some((split) => split.splitId === successor.splitId))
      context.addIssue({
        code: "custom",
        path: ["splitId"],
        message: "Successor split must exist in its resource",
      });
  });
export type WindowSplitSuccessor = z.infer<typeof WindowSplitSuccessorSchemaZ>;
