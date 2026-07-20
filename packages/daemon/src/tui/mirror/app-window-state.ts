import {
  APP_WINDOW_DOCUMENT_VERSION,
  APP_WINDOW_MAX_WINDOWS,
  AppWindowDocumentV1SchemaZ,
  AppWindowIdSchemaZ,
  AppWindowSourceSchemaZ,
  AppWindowTimestampSchemaZ,
  type AppWindowDocumentV1,
  type AppWindowInstance,
  type AppWindowNamedLayout,
  type AppWindowNativeSurface,
  type AppWindowScene,
  type AppWindowSource,
} from "@tmux-ide/contracts";

/**
 * Standalone durable kernel seam; it intentionally does not replace the
 * current WorkspaceUiStateV2 controller in this slice.
 *
 * Integration follow-ups:
 * - give this document its own project-runtime repository path and revision CAS;
 * - project root-owned window actions into this kernel before renderer updates;
 * - correlate terminalSourceId -> live `%pane_id` in an in-memory adapter only;
 * - retire view/dock layout fields from WorkspaceUiStateV2 after one-way migration.
 */

export type AppWindowStateDiagnosticCode =
  | "MALFORMED"
  | "UNSUPPORTED_VERSION"
  | "INVALID_FIELD"
  | "MIGRATED"
  | "TERMINAL_SOURCE_REQUIRED";

export interface AppWindowStateDiagnostic {
  code: AppWindowStateDiagnosticCode;
  path: string;
  message: string;
}

export interface ParsedAppWindowDocument {
  document: AppWindowDocumentV1;
  diagnostics: AppWindowStateDiagnostic[];
  writeProtected: boolean;
}

export interface MigratedAppWindowDocument {
  document: AppWindowDocumentV1;
  diagnostics: AppWindowStateDiagnostic[];
}

export interface MigrateWorkspaceUiStateOptions {
  migratedAt: string;
  /** Durable semantic terminal ids, never live tmux `%pane_id` values. */
  terminalSourceIds?: readonly string[];
}

const NATIVE_DOCK_ORDER = ["files", "changes", "missions", "activity"] as const;
const LEGACY_DOCK_TABS = new Set(NATIVE_DOCK_ORDER);
const LEGACY_PANELS = new Set(["home", "terminals", "files", "diff", "missions"]);

export function emptyAppWindowDocument(updatedAt: string): AppWindowDocumentV1 {
  const timestamp = AppWindowTimestampSchemaZ.parse(updatedAt);
  return AppWindowDocumentV1SchemaZ.parse({
    version: APP_WINDOW_DOCUMENT_VERSION,
    revision: 0,
    updatedAt: timestamp,
    windows: {},
    dockRoot: null,
    floatingOrder: [],
    focusedWindowId: null,
    activeLayoutId: null,
    layouts: {},
  });
}

/**
 * Deterministic instance identity derived only from durable source identity.
 * A caller-provided ordinal distinguishes deliberate duplicate views without
 * coupling identity to mutable titles, layout coordinates, or runtime handles.
 */
export function stableAppWindowInstanceId(source: AppWindowSource, ordinal = 0): string {
  const parsed = AppWindowSourceSchemaZ.parse(source);
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= APP_WINDOW_MAX_WINDOWS) {
    throw new Error("app window ordinal must be a bounded nonnegative integer");
  }
  const sourceKey =
    parsed.kind === "terminal"
      ? `terminal:${parsed.terminalSourceId}`
      : `native:${parsed.surface}:${parsed.resourceId ?? "default"}`;
  const slug = sourceKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return AppWindowIdSchemaZ.parse(`window-${slug || "surface"}-${ordinal}-${fnv1a(sourceKey)}`);
}

/**
 * Strictly validates durable state. Invalid current-version documents are
 * sanitized to an empty document; newer versions are write-protected so an
 * older binary cannot overwrite data it does not understand.
 */
export function parseAppWindowDocument(
  value: unknown,
  fallbackTimestamp: string,
): ParsedAppWindowDocument {
  const fallback = emptyAppWindowDocument(fallbackTimestamp);
  if (!isRecord(value)) {
    return {
      document: fallback,
      diagnostics: [diagnostic("MALFORMED", "$", "app window document must be an object")],
      writeProtected: false,
    };
  }
  if (value.version !== APP_WINDOW_DOCUMENT_VERSION) {
    return {
      document: fallback,
      diagnostics: [
        diagnostic(
          "UNSUPPORTED_VERSION",
          "$.version",
          `unsupported app window document version ${String(value.version)}`,
        ),
      ],
      writeProtected:
        typeof value.version === "number" && value.version > APP_WINDOW_DOCUMENT_VERSION,
    };
  }
  const parsed = AppWindowDocumentV1SchemaZ.safeParse(value);
  if (parsed.success) {
    return { document: canonicalDocument(parsed.data), diagnostics: [], writeProtected: false };
  }
  return {
    document: fallback,
    diagnostics: parsed.error.issues.map((issue) =>
      diagnostic(
        "INVALID_FIELD",
        issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`,
        issue.message,
      ),
    ),
    writeProtected: false,
  };
}

/**
 * One-way seam from the current WorkspaceUiStateV2 projection. Native dock
 * surfaces receive stable app-window instances. Terminals are migrated only
 * when their semantic source ids are supplied separately; live `%pane_id`
 * correlation is deliberately neither accepted nor persisted.
 */
export function migrateWorkspaceUiStateV2ToAppWindowDocument(
  value: unknown,
  options: MigrateWorkspaceUiStateOptions,
): MigratedAppWindowDocument {
  const migratedAt = AppWindowTimestampSchemaZ.parse(options.migratedAt);
  if (!isRecord(value) || value.version !== 2) {
    throw new Error("WorkspaceUiStateV2 is required for app window migration");
  }
  const diagnostics: AppWindowStateDiagnostic[] = [
    diagnostic("MIGRATED", "$", "migrated WorkspaceUiStateV2 to app window document V1"),
  ];
  const active = isRecord(value.active) ? value.active : null;
  const activePanel =
    typeof active?.panel === "string" && LEGACY_PANELS.has(active.panel)
      ? active.panel
      : "terminals";
  const dock = isRecord(value.dock) ? value.dock : null;
  const requestedDockTab =
    typeof dock?.activeTab === "string" && LEGACY_DOCK_TABS.has(dock.activeTab as never)
      ? (dock.activeTab as (typeof NATIVE_DOCK_ORDER)[number])
      : "files";
  const terminalSourceIds = cleanTerminalSourceIds(options.terminalSourceIds ?? []);
  if (activePanel === "terminals" && terminalSourceIds.length === 0) {
    diagnostics.push(
      diagnostic(
        "TERMINAL_SOURCE_REQUIRED",
        "$.active",
        "terminal canvas was not persisted because no durable terminal source id was supplied",
      ),
    );
  }

  const windows: Record<string, AppWindowInstance> = {};
  const dockWindowIds = NATIVE_DOCK_ORDER.map((surface, index) => {
    const source: AppWindowSource = { kind: "native", surface, resourceId: null };
    const id = stableAppWindowInstanceId(source);
    windows[id] = dockedWindow(id, source, nativeTitle(surface), "stack-native-dock", index);
    return id;
  });
  const requestedDockWindowId = dockWindowIds[NATIVE_DOCK_ORDER.indexOf(requestedDockTab)]!;

  const canvasWindowIds: string[] = [];
  if (activePanel === "home") {
    const source: AppWindowSource = { kind: "native", surface: "home", resourceId: null };
    const id = stableAppWindowInstanceId(source);
    windows[id] = dockedWindow(id, source, "Home", "stack-canvas", canvasWindowIds.length);
    canvasWindowIds.push(id);
  }
  for (const terminalSourceId of terminalSourceIds) {
    const source: AppWindowSource = { kind: "terminal", terminalSourceId };
    const id = stableAppWindowInstanceId(source);
    windows[id] = dockedWindow(id, source, null, "stack-canvas", canvasWindowIds.length);
    canvasWindowIds.push(id);
  }

  const nativeDock = {
    type: "stack" as const,
    id: "stack-native-dock",
    windowIds: dockWindowIds,
    activeWindowId: requestedDockWindowId,
  };
  const dockRoot =
    canvasWindowIds.length === 0
      ? nativeDock
      : {
          type: "split" as const,
          id: "split-workbench",
          axis: "vertical" as const,
          children: [
            {
              type: "stack" as const,
              id: "stack-canvas",
              windowIds: canvasWindowIds,
              activeWindowId: canvasWindowIds[0]!,
            },
            nativeDock,
          ],
          weights: [3, 1],
        };
  const focusedWindowId =
    dock?.focusZone === "dock-tabs" || dock?.focusZone === "dock-body"
      ? requestedDockWindowId
      : (canvasWindowIds[0] ?? null);
  const scene: AppWindowScene = {
    windows,
    dockRoot,
    floatingOrder: [],
    focusedWindowId,
  };
  const layoutId = "layout-migrated-workspace";
  const layout: AppWindowNamedLayout = {
    id: layoutId,
    name: "Migrated workspace",
    description: "Initial app-window layout migrated from WorkspaceUiStateV2",
    revision: 1,
    createdAt: migratedAt,
    updatedAt: migratedAt,
    scene: cloneScene(scene),
  };
  const document = AppWindowDocumentV1SchemaZ.parse({
    version: APP_WINDOW_DOCUMENT_VERSION,
    revision: 0,
    updatedAt: migratedAt,
    ...scene,
    activeLayoutId: layoutId,
    layouts: { [layoutId]: layout },
  });
  return { document: canonicalDocument(document), diagnostics };
}

export function saveAppWindowNamedLayout(
  document: AppWindowDocumentV1,
  input: { id: string; name: string; description?: string | null; updatedAt: string },
): AppWindowDocumentV1 {
  const current = AppWindowDocumentV1SchemaZ.parse(document);
  const id = AppWindowIdSchemaZ.parse(input.id);
  const updatedAt = AppWindowTimestampSchemaZ.parse(input.updatedAt);
  const previous = current.layouts[id];
  const nextLayout: AppWindowNamedLayout = {
    id,
    name: input.name,
    description: input.description ?? null,
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? updatedAt,
    updatedAt,
    scene: cloneScene(current),
  };
  return canonicalDocument(
    AppWindowDocumentV1SchemaZ.parse({
      ...current,
      revision: current.revision + 1,
      updatedAt,
      activeLayoutId: id,
      layouts: { ...current.layouts, [id]: nextLayout },
    }),
  );
}

export function restoreAppWindowNamedLayout(
  document: AppWindowDocumentV1,
  layoutId: string,
  updatedAt: string,
): AppWindowDocumentV1 {
  const current = AppWindowDocumentV1SchemaZ.parse(document);
  const id = AppWindowIdSchemaZ.parse(layoutId);
  const timestamp = AppWindowTimestampSchemaZ.parse(updatedAt);
  const layout = current.layouts[id];
  if (!layout) throw new Error(`unknown app window layout "${id}"`);
  return canonicalDocument(
    AppWindowDocumentV1SchemaZ.parse({
      ...current,
      ...cloneScene(layout.scene),
      revision: current.revision + 1,
      updatedAt: timestamp,
      activeLayoutId: id,
    }),
  );
}

export function focusAppWindow(
  document: AppWindowDocumentV1,
  windowId: string | null,
  updatedAt: string,
): AppWindowDocumentV1 {
  const current = AppWindowDocumentV1SchemaZ.parse(document);
  const id = windowId === null ? null : AppWindowIdSchemaZ.parse(windowId);
  if (id && !current.windows[id]) throw new Error(`unknown app window "${id}"`);
  const floatingOrder =
    id && current.windows[id]?.placement.mode === "floating"
      ? [...current.floatingOrder.filter((candidate) => candidate !== id), id]
      : current.floatingOrder;
  return canonicalDocument(
    AppWindowDocumentV1SchemaZ.parse({
      ...current,
      revision: current.revision + 1,
      updatedAt: AppWindowTimestampSchemaZ.parse(updatedAt),
      focusedWindowId: id,
      floatingOrder,
    }),
  );
}

export function serializeAppWindowDocument(document: AppWindowDocumentV1): string {
  return `${JSON.stringify(canonicalDocument(AppWindowDocumentV1SchemaZ.parse(document)), null, 2)}\n`;
}

function dockedWindow(
  id: string,
  source: AppWindowSource,
  title: string | null,
  stackId: string,
  index: number,
): AppWindowInstance {
  return {
    id,
    source,
    title,
    placement: {
      mode: "docked",
      docked: { stackId, index },
      floating: null,
    },
  };
}

function cleanTerminalSourceIds(values: readonly string[]): string[] {
  if (values.length > APP_WINDOW_MAX_WINDOWS - NATIVE_DOCK_ORDER.length) {
    throw new Error("terminal source id limit exceeded");
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const sourceId = AppWindowIdSchemaZ.parse(value);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    result.push(sourceId);
  }
  return result;
}

function nativeTitle(surface: AppWindowNativeSurface): string {
  if (surface === "changes") return "Changes";
  return `${surface[0]!.toUpperCase()}${surface.slice(1)}`;
}

function cloneScene(scene: AppWindowScene): AppWindowScene {
  return {
    windows: structuredClone(scene.windows),
    dockRoot: structuredClone(scene.dockRoot),
    floatingOrder: [...scene.floatingOrder],
    focusedWindowId: scene.focusedWindowId,
  };
}

function canonicalDocument(document: AppWindowDocumentV1): AppWindowDocumentV1 {
  const layouts = Object.fromEntries(
    Object.entries(document.layouts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, layout]) => [id, { ...layout, scene: canonicalScene(layout.scene) }]),
  );
  return AppWindowDocumentV1SchemaZ.parse({
    ...document,
    ...canonicalScene(document),
    layouts,
  });
}

function canonicalScene(scene: AppWindowScene): AppWindowScene {
  return {
    windows: Object.fromEntries(
      Object.entries(scene.windows).sort(([left], [right]) => left.localeCompare(right)),
    ),
    dockRoot: structuredClone(scene.dockRoot),
    floatingOrder: [...scene.floatingOrder],
    focusedWindowId: scene.focusedWindowId,
  };
}

function diagnostic(
  code: AppWindowStateDiagnosticCode,
  path: string,
  message: string,
): AppWindowStateDiagnostic {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
