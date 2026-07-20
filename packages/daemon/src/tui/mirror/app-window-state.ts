import {
  APP_WINDOW_DOCUMENT_VERSION,
  APP_WINDOW_MAX_WINDOWS,
  AppWindowDocumentV1SchemaZ,
  AppWindowIdSchemaZ,
  AppWindowSourceSchemaZ,
  AppWindowTimestampSchemaZ,
  type AppWindowDockNodeShape,
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
  | "TERMINAL_SOURCE_REQUIRED"
  | "COMPOSITE_LAYOUT_DEFERRED"
  | "FIELD_DEFAULTED";

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
  /** Stable focus input used to select one terminal when several are present. */
  focusedTerminalSourceId?: string | null;
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
    dockState: { mode: "open", preferredHeight: null, focusZone: "canvas" },
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
      : `native:${parsed.surface}:${parsed.resourceId === null ? "null" : `id:${parsed.resourceId}`}`;
  const slug = sourceKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return AppWindowIdSchemaZ.parse(`window-${slug || "surface"}-${ordinal}-${fnv1a(sourceKey)}`);
}

/**
 * Strictly validates durable state. Invalid current-version documents expose
 * an empty recovery projection under write protection; newer versions are
 * likewise protected so an older binary cannot overwrite unknown data.
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
  const version = ownValue(value, "version");
  if (version !== APP_WINDOW_DOCUMENT_VERSION) {
    return {
      document: fallback,
      diagnostics: [
        diagnostic(
          "UNSUPPORTED_VERSION",
          "$.version",
          `unsupported app window document version ${String(version)}`,
        ),
      ],
      writeProtected: typeof version === "number" && version > APP_WINDOW_DOCUMENT_VERSION,
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
    writeProtected: true,
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
  if (!isRecord(value) || ownValue(value, "version") !== 2) {
    throw new Error("WorkspaceUiStateV2 is required for app window migration");
  }
  const diagnostics: AppWindowStateDiagnostic[] = [
    diagnostic("MIGRATED", "$", "migrated WorkspaceUiStateV2 to app window document V1"),
  ];
  const activeValue = ownValue(value, "active");
  const active = isRecord(activeValue) ? activeValue : null;
  const activeViewId = ownString(active, "viewId");
  const activePanelValue = ownValue(active, "panel");
  const activePanel =
    typeof activePanelValue === "string" && LEGACY_PANELS.has(activePanelValue)
      ? activePanelValue
      : "terminals";
  const dockValue = ownValue(value, "dock");
  const dock = isRecord(dockValue) ? dockValue : null;
  const dockTabValue = ownValue(dock, "activeTab");
  const requestedDockTab =
    typeof dockTabValue === "string" && LEGACY_DOCK_TABS.has(dockTabValue as never)
      ? (dockTabValue as (typeof NATIVE_DOCK_ORDER)[number])
      : "files";
  const dockMode = legacyDockMode(ownValue(dock, "mode"), diagnostics);
  const preferredHeight = legacyPreferredHeight(ownValue(dock, "preferredHeight"), diagnostics);
  const focusZone = legacyFocusZone(ownValue(dock, "focusZone"), diagnostics);
  const terminalSourceIds = cleanTerminalSourceIds(options.terminalSourceIds ?? []);
  const focusedTerminalSourceId = cleanFocusedTerminalSourceId(
    terminalSourceIds,
    options.focusedTerminalSourceId,
  );
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
  const windowIdByViewId = new Map<string, string>();
  const deferredViewIds = new Set<string>();
  const viewsValue = ownValue(value, "views");
  const views = isRecord(viewsValue) ? viewsValue : {};
  for (const [viewId, rawView] of Object.entries(views).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isRecord(rawView)) continue;
    const surface = legacyNativeSurface(ownValue(rawView, "panel"));
    if (!surface) continue;
    if (Object.hasOwn(rawView, "layout")) {
      deferredViewIds.add(viewId);
      diagnostics.push(
        diagnostic(
          "COMPOSITE_LAYOUT_DEFERRED",
          `$.views.${viewId}.layout`,
          "composite layout state needs its configured layout tree before app-window migration",
        ),
      );
      continue;
    }
    const source: AppWindowSource = {
      kind: "native",
      surface,
      resourceId: stableLegacyResourceId(viewId),
    };
    const id = stableAppWindowInstanceId(source);
    windows[id] = dockedWindow(
      id,
      source,
      nativeTitle(surface),
      "stack-canvas",
      canvasWindowIds.length,
    );
    canvasWindowIds.push(id);
    windowIdByViewId.set(viewId, id);
  }
  const activeNativeSurface = legacyNativeSurface(activePanel);
  if (
    activeNativeSurface &&
    activeViewId &&
    !windowIdByViewId.has(activeViewId) &&
    !deferredViewIds.has(activeViewId)
  ) {
    const source: AppWindowSource = {
      kind: "native",
      surface: activeNativeSurface,
      resourceId: stableLegacyResourceId(activeViewId),
    };
    const id = stableAppWindowInstanceId(source);
    windows[id] = dockedWindow(
      id,
      source,
      nativeTitle(activeNativeSurface),
      "stack-canvas",
      canvasWindowIds.length,
    );
    canvasWindowIds.push(id);
    windowIdByViewId.set(activeViewId, id);
  }
  const terminalWindowIdBySourceId = new Map<string, string>();
  for (const terminalSourceId of terminalSourceIds) {
    const source: AppWindowSource = { kind: "terminal", terminalSourceId };
    const id = stableAppWindowInstanceId(source);
    windows[id] = dockedWindow(id, source, null, "stack-canvas", canvasWindowIds.length);
    canvasWindowIds.push(id);
    terminalWindowIdBySourceId.set(terminalSourceId, id);
  }
  const preferredCanvasWindowId =
    activePanel === "terminals"
      ? focusedTerminalSourceId
        ? terminalWindowIdBySourceId.get(focusedTerminalSourceId)
        : undefined
      : activeViewId
        ? windowIdByViewId.get(activeViewId)
        : undefined;
  const activeCanvasWindowId = preferredCanvasWindowId ?? canvasWindowIds[0];

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
              activeWindowId: activeCanvasWindowId!,
            },
            nativeDock,
          ],
          weights: [3, 1],
        };
  const focusedWindowId =
    focusZone === "dock-tabs" || focusZone === "dock-body"
      ? requestedDockWindowId
      : (preferredCanvasWindowId ?? null);
  const scene: AppWindowScene = {
    windows,
    dockRoot,
    dockState: { mode: dockMode, preferredHeight, focusZone },
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
  requireNondecreasingTimestamp(current.updatedAt, updatedAt);
  const previous = Object.hasOwn(current.layouts, id) ? current.layouts[id] : undefined;
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
  requireNondecreasingTimestamp(current.updatedAt, timestamp);
  const layout = Object.hasOwn(current.layouts, id) ? current.layouts[id] : undefined;
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
  const timestamp = AppWindowTimestampSchemaZ.parse(updatedAt);
  requireNondecreasingTimestamp(current.updatedAt, timestamp);
  if (id && !Object.hasOwn(current.windows, id)) throw new Error(`unknown app window "${id}"`);
  const floatingOrder =
    id && current.windows[id]?.placement.mode === "floating"
      ? [...current.floatingOrder.filter((candidate) => candidate !== id), id]
      : current.floatingOrder;
  const dockRoot = id ? activateDockedWindow(current.dockRoot, id) : current.dockRoot;
  return canonicalDocument(
    AppWindowDocumentV1SchemaZ.parse({
      ...current,
      revision: current.revision + 1,
      updatedAt: timestamp,
      focusedWindowId: id,
      floatingOrder,
      dockRoot,
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

function cleanFocusedTerminalSourceId(
  terminalSourceIds: readonly string[],
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return terminalSourceIds[0] ?? null;
  const sourceId = AppWindowIdSchemaZ.parse(value);
  if (!terminalSourceIds.includes(sourceId)) {
    throw new Error("focused terminal source id must belong to terminalSourceIds");
  }
  return sourceId;
}

function legacyNativeSurface(value: unknown): AppWindowNativeSurface | null {
  if (value === "home" || value === "files" || value === "missions") return value;
  if (value === "diff") return "changes";
  return null;
}

function stableLegacyResourceId(viewId: string): string {
  const direct = AppWindowIdSchemaZ.safeParse(viewId);
  if (direct.success) return direct.data;
  const slug = viewId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return AppWindowIdSchemaZ.parse(`view-${slug || "resource"}-${fnv1a(viewId)}`);
}

function legacyDockMode(
  value: unknown,
  diagnostics: AppWindowStateDiagnostic[],
): "collapsed" | "open" | "maximized" {
  if (value === "collapsed" || value === "open" || value === "maximized") return value;
  diagnostics.push(
    diagnostic("FIELD_DEFAULTED", "$.dock.mode", "invalid dock mode defaulted to open"),
  );
  return "open";
}

function legacyPreferredHeight(
  value: unknown,
  diagnostics: AppWindowStateDiagnostic[],
): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000) {
    return value;
  }
  diagnostics.push(
    diagnostic(
      "FIELD_DEFAULTED",
      "$.dock.preferredHeight",
      "invalid preferred dock height defaulted to automatic",
    ),
  );
  return null;
}

function legacyFocusZone(
  value: unknown,
  diagnostics: AppWindowStateDiagnostic[],
): "canvas" | "dock-tabs" | "dock-body" {
  if (value === "canvas" || value === "dock-tabs" || value === "dock-body") return value;
  diagnostics.push(
    diagnostic("FIELD_DEFAULTED", "$.dock.focusZone", "invalid focus zone defaulted to canvas"),
  );
  return "canvas";
}

function activateDockedWindow(
  node: AppWindowDockNodeShape | null,
  windowId: string,
): AppWindowDockNodeShape | null {
  if (!node) return null;
  if (node.type === "stack") {
    return node.windowIds.includes(windowId) ? { ...node, activeWindowId: windowId } : node;
  }
  return {
    ...node,
    children: node.children.map((child) => activateDockedWindow(child, windowId)!),
  };
}

function nativeTitle(surface: AppWindowNativeSurface): string {
  if (surface === "changes") return "Changes";
  return `${surface[0]!.toUpperCase()}${surface.slice(1)}`;
}

function cloneScene(scene: AppWindowScene): AppWindowScene {
  return {
    windows: structuredClone(scene.windows),
    dockRoot: structuredClone(scene.dockRoot),
    dockState: { ...scene.dockState },
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
    dockState: { ...scene.dockState },
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

function ownValue(record: Record<string, unknown> | null, key: string): unknown {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function ownString(record: Record<string, unknown> | null, key: string): string | null {
  const value = ownValue(record, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireNondecreasingTimestamp(previous: string, next: string): void {
  if (Date.parse(next) < Date.parse(previous)) {
    throw new Error("app window mutation timestamp must not move backwards");
  }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
