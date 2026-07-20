import { z } from "zod";

/** Durable app-window state. Runtime renderer and tmux correlations never belong here. */
export const APP_WINDOW_DOCUMENT_VERSION = 1 as const;
export const APP_WINDOW_MAX_WINDOWS = 128;
export const APP_WINDOW_MAX_LAYOUTS = 32;
export const APP_WINDOW_MAX_TREE_DEPTH = 24;
export const APP_WINDOW_MAX_TREE_NODES = 255;
export const APP_WINDOW_MAX_ID_LENGTH = 128;
export const APP_WINDOW_MAX_TITLE_LENGTH = 160;

const RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const finiteCoordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const finiteExtent = z.number().finite().positive().max(1_000_000);
const VisibleTextSchemaZ = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes("\0"), "text must not contain NUL bytes")
    .refine((value) => value.trim().length > 0, "text must contain visible characters");

export const AppWindowIdSchemaZ = z
  .string()
  .min(1)
  .max(APP_WINDOW_MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine((value) => !RESERVED_RECORD_KEYS.has(value), "reserved record key is not allowed");
export type AppWindowId = z.infer<typeof AppWindowIdSchemaZ>;

export const AppWindowTimestampSchemaZ = z.string().datetime({ offset: false });

export const AppWindowNativeSurfaceSchemaZ = z.enum([
  "home",
  "files",
  "changes",
  "missions",
  "activity",
]);
export type AppWindowNativeSurface = z.infer<typeof AppWindowNativeSurfaceSchemaZ>;

export const AppWindowSourceSchemaZ = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("native"),
      surface: AppWindowNativeSurfaceSchemaZ,
      /** Stable resource identity for multiple instances of one native surface. */
      resourceId: AppWindowIdSchemaZ.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("terminal"),
      /** Durable semantic source id. A live tmux `%pane_id` is intentionally invalid. */
      terminalSourceId: AppWindowIdSchemaZ,
    })
    .strict(),
]);
export type AppWindowSource = z.infer<typeof AppWindowSourceSchemaZ>;

export const AppWindowRectSchemaZ = z
  .object({
    x: finiteCoordinate,
    y: finiteCoordinate,
    width: finiteExtent,
    height: finiteExtent,
  })
  .strict();
export type AppWindowRect = z.infer<typeof AppWindowRectSchemaZ>;

export const AppWindowDockMemorySchemaZ = z
  .object({
    stackId: AppWindowIdSchemaZ,
    index: z
      .number()
      .int()
      .nonnegative()
      .max(APP_WINDOW_MAX_WINDOWS - 1),
  })
  .strict();
export type AppWindowDockMemory = z.infer<typeof AppWindowDockMemorySchemaZ>;

export const AppWindowPlacementSchemaZ = z
  .object({
    mode: z.enum(["docked", "floating"]),
    /** Current dock location when docked; last dock location when floating. */
    docked: AppWindowDockMemorySchemaZ.nullable(),
    /** Current rect when floating; last floating rect when docked. */
    floating: AppWindowRectSchemaZ.nullable(),
  })
  .strict()
  .superRefine((placement, ctx) => {
    if (placement.mode === "docked" && placement.docked === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "docked windows require dock placement memory",
        path: ["docked"],
      });
    }
    if (placement.mode === "floating" && placement.floating === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "floating windows require a floating rect",
        path: ["floating"],
      });
    }
  });
export type AppWindowPlacement = z.infer<typeof AppWindowPlacementSchemaZ>;

export const AppWindowInstanceSchemaZ = z
  .object({
    id: AppWindowIdSchemaZ,
    source: AppWindowSourceSchemaZ,
    title: VisibleTextSchemaZ(APP_WINDOW_MAX_TITLE_LENGTH).nullable(),
    placement: AppWindowPlacementSchemaZ,
  })
  .strict();
export type AppWindowInstance = z.infer<typeof AppWindowInstanceSchemaZ>;

export type AppWindowDockNodeShape =
  | {
      type: "stack";
      id: string;
      windowIds: string[];
      activeWindowId: string;
    }
  | {
      type: "split";
      id: string;
      axis: "horizontal" | "vertical";
      children: AppWindowDockNodeShape[];
      weights: number[];
    };

const AppWindowDockNodeRecursiveSchemaZ: z.ZodType<AppWindowDockNodeShape> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("stack"),
        id: AppWindowIdSchemaZ,
        windowIds: z.array(AppWindowIdSchemaZ).min(1).max(APP_WINDOW_MAX_WINDOWS),
        activeWindowId: AppWindowIdSchemaZ,
      })
      .strict()
      .superRefine((stack, ctx) => {
        if (new Set(stack.windowIds).size !== stack.windowIds.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "stack window ids must be unique",
            path: ["windowIds"],
          });
        }
        if (!stack.windowIds.includes(stack.activeWindowId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "active window must belong to the stack",
            path: ["activeWindowId"],
          });
        }
      }),
    z
      .object({
        type: z.literal("split"),
        id: AppWindowIdSchemaZ,
        axis: z.enum(["horizontal", "vertical"]),
        children: z.array(AppWindowDockNodeRecursiveSchemaZ).min(2).max(8),
        weights: z.array(z.number().int().positive().max(1_000_000)).min(2).max(8),
      })
      .strict()
      .refine((node) => node.children.length === node.weights.length, {
        message: "split weights must match children",
        path: ["weights"],
      }),
  ]),
);

export const AppWindowDockNodeSchemaZ: z.ZodType<AppWindowDockNodeShape> = z
  .unknown()
  .superRefine((value, ctx) => {
    const failure = dockTreeLimitFailure(value);
    if (failure) ctx.addIssue({ code: z.ZodIssueCode.custom, message: failure });
  })
  .pipe(AppWindowDockNodeRecursiveSchemaZ);

function dockTreeLimitFailure(value: unknown): string | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > APP_WINDOW_MAX_TREE_NODES) return "dock tree node limit exceeded";
    if (current.depth > APP_WINDOW_MAX_TREE_DEPTH) return "dock tree depth limit exceeded";
    if (
      current.value &&
      typeof current.value === "object" &&
      !Array.isArray(current.value) &&
      "type" in current.value &&
      current.value.type === "split" &&
      "children" in current.value &&
      Array.isArray(current.value.children)
    ) {
      if (current.value.children.length > 8) return "dock split child limit exceeded";
      for (const child of current.value.children) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

const AppWindowSceneShapeSchemaZ = z
  .object({
    windows: z.record(AppWindowIdSchemaZ, AppWindowInstanceSchemaZ),
    dockRoot: AppWindowDockNodeSchemaZ.nullable(),
    /** Back-to-front order. The last id is the top-most floating window. */
    floatingOrder: z.array(AppWindowIdSchemaZ).max(APP_WINDOW_MAX_WINDOWS),
    focusedWindowId: AppWindowIdSchemaZ.nullable(),
  })
  .strict();

function refineScene(
  scene: z.infer<typeof AppWindowSceneShapeSchemaZ>,
  ctx: z.RefinementCtx,
): void {
  const windowEntries = Object.entries(scene.windows);
  if (windowEntries.length > APP_WINDOW_MAX_WINDOWS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "app window limit exceeded",
      path: ["windows"],
    });
  }
  for (const [key, window] of windowEntries) {
    if (key !== window.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "window record key must match window id",
        path: ["windows", key, "id"],
      });
    }
  }

  const dockMembership = new Map<string, { stackId: string; index: number }>();
  const nodeIds = new Set<string>();
  const visit = (node: AppWindowDockNodeShape): void => {
    if (nodeIds.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dock node ids must be unique",
        path: ["dockRoot"],
      });
    }
    nodeIds.add(node.id);
    if (node.type === "split") {
      for (const child of node.children) visit(child);
      return;
    }
    for (const [index, windowId] of node.windowIds.entries()) {
      if (dockMembership.has(windowId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "docked window must occur in exactly one stack",
          path: ["dockRoot"],
        });
      }
      dockMembership.set(windowId, { stackId: node.id, index });
    }
  };
  if (scene.dockRoot) visit(scene.dockRoot);

  const floatingSet = new Set(scene.floatingOrder);
  if (floatingSet.size !== scene.floatingOrder.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "floating z-order ids must be unique",
      path: ["floatingOrder"],
    });
  }

  for (const [windowId, window] of windowEntries) {
    const dockedAt = dockMembership.get(windowId);
    const isFloating = floatingSet.has(windowId);
    if (window.placement.mode === "docked") {
      if (!dockedAt || isFloating) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "docked window must occur only in the dock tree",
          path: ["windows", windowId, "placement"],
        });
      } else if (
        window.placement.docked?.stackId !== dockedAt.stackId ||
        window.placement.docked.index !== dockedAt.index
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "dock placement memory must match current stack membership",
          path: ["windows", windowId, "placement", "docked"],
        });
      }
    } else if (dockedAt || !isFloating) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "floating window must occur only in floating z-order",
        path: ["windows", windowId, "placement"],
      });
    }
  }
  for (const windowId of dockMembership.keys()) {
    if (!scene.windows[windowId]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dock tree references an unknown window",
        path: ["dockRoot"],
      });
    }
  }
  for (const windowId of floatingSet) {
    if (!scene.windows[windowId]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "floating z-order references an unknown window",
        path: ["floatingOrder"],
      });
    }
  }
  if (scene.focusedWindowId && !scene.windows[scene.focusedWindowId]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "focused window must exist",
      path: ["focusedWindowId"],
    });
  }
}

export const AppWindowSceneSchemaZ = AppWindowSceneShapeSchemaZ.superRefine(refineScene);
export type AppWindowScene = z.infer<typeof AppWindowSceneSchemaZ>;

export const AppWindowNamedLayoutSchemaZ = z
  .object({
    id: AppWindowIdSchemaZ,
    name: VisibleTextSchemaZ(80),
    description: VisibleTextSchemaZ(512).nullable(),
    revision: z.number().int().positive(),
    createdAt: AppWindowTimestampSchemaZ,
    updatedAt: AppWindowTimestampSchemaZ,
    scene: AppWindowSceneSchemaZ,
  })
  .strict()
  .refine((layout) => Date.parse(layout.updatedAt) >= Date.parse(layout.createdAt), {
    message: "layout updatedAt must not precede createdAt",
    path: ["updatedAt"],
  });
export type AppWindowNamedLayout = z.infer<typeof AppWindowNamedLayoutSchemaZ>;

export const AppWindowDocumentV1SchemaZ = AppWindowSceneShapeSchemaZ.extend({
  version: z.literal(APP_WINDOW_DOCUMENT_VERSION),
  revision: z.number().int().nonnegative(),
  updatedAt: AppWindowTimestampSchemaZ,
  activeLayoutId: AppWindowIdSchemaZ.nullable(),
  layouts: z.record(AppWindowIdSchemaZ, AppWindowNamedLayoutSchemaZ),
})
  .strict()
  .superRefine((document, ctx) => {
    refineScene(document, ctx);
    if (Object.keys(document.layouts).length > APP_WINDOW_MAX_LAYOUTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "named layout limit exceeded",
        path: ["layouts"],
      });
    }
    for (const [key, layout] of Object.entries(document.layouts)) {
      if (key !== layout.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "layout record key must match layout id",
          path: ["layouts", key, "id"],
        });
      }
    }
    if (document.activeLayoutId && !document.layouts[document.activeLayoutId]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "active layout must exist",
        path: ["activeLayoutId"],
      });
    }
  });
export type AppWindowDocumentV1 = z.infer<typeof AppWindowDocumentV1SchemaZ>;
