import { createMemo, createSignal, Show, type Accessor } from "solid-js";
import type { AgentProvider, ChatThreadUsageSummary, StopReason, ThreadState } from "../types";
import type { ProviderInfo } from "../api";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { OpenInPicker, type EditorId } from "./OpenInPicker";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { DEFAULT_MODEL_BY_KIND, PROVIDER_MODEL_CATALOG } from "../lib/providerModelCatalog";
import {
  loadModelFavorites,
  toggleModelFavorite,
  type ModelFavorite,
} from "../lib/modelFavoritesStore";
import { VscodeEntryIcon, basename } from "./VscodeEntryIcon";

/**
 * Built-in editor list used when the host doesn't supply detection.
 * Covers the VS Code family + Cursor + Zed + a generic file-manager
 * fallback so the picker is useful on any developer's machine.
 */
const DEFAULT_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [
  "vscode",
  "cursor",
  "vscode-insiders",
  "vscodium",
  "zed",
  "file-manager",
];

const DEFAULT_PREFERRED_EDITOR: EditorId = "vscode";

const PREFERRED_EDITOR_STORAGE_KEY = "chat-solid:open-in:preferred-editor";

/**
 * URL scheme for each known editor. Clicking the OpenInPicker fires
 * `window.open("<scheme>://file/<cwd>")` when the host hasn't wired
 * a custom `onOpenInEditor` — every editor in the registry has a
 * `<scheme>://file/<path>` deeplink that resolves to "open this
 * folder" on the user's machine.
 */
const EDITOR_URL_SCHEME: Record<EditorId, string> = {
  cursor: "cursor",
  trae: "trae",
  kiro: "kiro",
  vscode: "vscode",
  "vscode-insiders": "vscode-insiders",
  vscodium: "vscodium",
  zed: "zed",
  antigravity: "antigravity",
  idea: "idea",
  "file-manager": "file",
};

function readStoredPreferredEditor(): EditorId | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PREFERRED_EDITOR_STORAGE_KEY);
    if (!raw) return null;
    return raw as EditorId;
  } catch {
    return null;
  }
}

function writeStoredPreferredEditor(value: EditorId): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREFERRED_EDITOR_STORAGE_KEY, value);
  } catch {
    /* quota / privacy mode — silently no-op */
  }
}

function defaultOpenInEditor(editorId: EditorId, cwd: string): void {
  if (typeof window === "undefined") return;
  const scheme = EDITOR_URL_SCHEME[editorId] ?? "vscode";
  const encoded = cwd.startsWith("/") ? cwd : `/${cwd}`;
  window.open(`${scheme}://file${encoded}`, "_blank", "noopener,noreferrer");
}

interface ChatHeaderProps {
  thread: Accessor<ThreadState | null>;
  inflight: Accessor<boolean>;
  stopReason: Accessor<StopReason | null>;
  usage: Accessor<ChatThreadUsageSummary | null>;
  sessionName: Accessor<string | null>;
  /** Discovered providers used by the right-slot model picker. */
  availableProviders?: Accessor<ReadonlyArray<ProviderInfo>>;
  /** Fires when the picker selects a different provider. */
  onProviderChange?: (next: AgentProvider) => void;
  /**
   * Editors detected on the host machine, used by the
   * `OpenInPicker` chip. When omitted, the picker uses the built-in
   * default list (Cursor / VS Code family / Zed / file manager) so
   * the chip is always available when the thread has a project
   * directory.
   */
  availableEditors?: Accessor<ReadonlyArray<EditorId>>;
  /**
   * Currently-preferred editor. When omitted, the chip reads
   * (and writes) `localStorage["chat-solid:open-in:preferred-editor"]`
   * so the user's choice sticks across reloads without host plumbing.
   */
  preferredEditor?: Accessor<EditorId | null>;
  /**
   * Project directory passed to the editor when the user clicks.
   * Defaults to `thread().projectDir` — the picker hides whenever
   * neither this prop nor the thread has a project dir.
   */
  openInCwd?: Accessor<string | null>;
  /**
   * Host hook for the shell `openInEditor` API. When omitted, the
   * chip opens `<scheme>://file/<cwd>` via `window.open` (every
   * supported editor exposes that deeplink), which is enough for a
   * browser-based host to launch the editor on the user's machine.
   */
  onOpenInEditor?: (editorId: EditorId, cwd: string) => void;
  /**
   * Persisted by the host. When omitted, the chip writes the new
   * preferred editor to localStorage so subsequent reloads pick the
   * same default.
   */
  onPreferredEditorChange?: (editorId: EditorId) => void;
  /** Optional shortcut hint surfaced next to the preferred row. */
  openInFavoriteShortcutLabel?: Accessor<string | null>;
  onCancel(): void;
  onRename(title: string): Promise<void>;
  onClose?: () => void;
  /** Fires when the Delete button is clicked. Host owns the
   *  destructive-action confirm and the daemon dispatch — see
   *  ChatMountOptions.onDelete for the contract. */
  onDelete?: () => void;
}

export function ChatHeader(props: ChatHeaderProps) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const activeProvider = createMemo(() => props.thread()?.provider ?? null);
  const providerList = createMemo<ReadonlyArray<ProviderInfo>>(
    () => props.availableProviders?.() ?? [],
  );

  // Model picker: static catalog + persisted favorites. The daemon
  // has no per-model transport, so picking a model switches the
  // provider (when it differs) and records the slug client-side so
  // the active row + trigger reflect the choice.
  const modelsByKind = createMemo(() => PROVIDER_MODEL_CATALOG);
  const [favorites, setFavorites] = createSignal<ModelFavorite[]>(loadModelFavorites());
  const favoriteTuples = createMemo(() => favorites().map((f) => ({ kind: f.kind, slug: f.slug })));
  const [pickedModelByKind, setPickedModelByKind] = createSignal<Record<string, string>>({});
  const activeModel = createMemo<string | null>(() => {
    const kind = activeProvider()?.kind ?? null;
    if (!kind) return null;
    return pickedModelByKind()[kind] ?? DEFAULT_MODEL_BY_KIND.get(kind) ?? null;
  });
  const builtInProvider = (kind: string): AgentProvider | null => {
    if (kind === "claude-code") return { kind: "claude-code" };
    if (kind === "codex") return { kind: "codex" };
    if (kind === "gemini") return { kind: "gemini" };
    return null;
  };
  const handlePickModel = (kind: string, slug: string): void => {
    setPickedModelByKind((prev) => ({ ...prev, [kind]: slug }));
    if (kind !== (activeProvider()?.kind ?? null)) {
      const next = builtInProvider(kind);
      if (next) props.onProviderChange?.(next);
    }
  };
  const handleToggleFavorite = (kind: string, slug: string): void => {
    setFavorites((current) => toggleModelFavorite(current, { kind, slug }));
  };

  // OpenInPicker plumbing — self-sufficient when the host doesn't
  // wire the editor surfaces. We default the cwd to the thread's
  // project dir, the editor list to the curated built-in registry,
  // and persist the preferred editor in localStorage so it sticks
  // across reloads. Hosts can override any piece via the matching
  // prop.
  const projectDir = createMemo<string | null>(() => props.thread()?.projectDir ?? null);
  const openInCwd = createMemo<string | null>(() => props.openInCwd?.() ?? projectDir());
  const availableEditors = createMemo<ReadonlyArray<EditorId>>(
    () => props.availableEditors?.() ?? DEFAULT_AVAILABLE_EDITORS,
  );
  const [storedPreferredEditor, setStoredPreferredEditor] = createSignal<EditorId | null>(
    readStoredPreferredEditor(),
  );
  const preferredEditor = createMemo<EditorId | null>(
    () => props.preferredEditor?.() ?? storedPreferredEditor() ?? DEFAULT_PREFERRED_EDITOR,
  );
  const showOpenInPicker = createMemo<boolean>(() => Boolean(openInCwd()));
  const handleOpenInEditor = (editorId: EditorId, cwd: string): void => {
    if (props.onOpenInEditor) {
      props.onOpenInEditor(editorId, cwd);
      return;
    }
    defaultOpenInEditor(editorId, cwd);
  };
  const handlePreferredEditorChange = (editorId: EditorId): void => {
    if (props.onPreferredEditorChange) {
      props.onPreferredEditorChange(editorId);
      return;
    }
    setStoredPreferredEditor(editorId);
    writeStoredPreferredEditor(editorId);
  };

  function beginEdit() {
    setDraft(props.thread()?.title ?? "New chat");
    setEditing(true);
  }

  async function commit() {
    const title = draft().trim();
    setEditing(false);
    if (title && title !== props.thread()?.title) await props.onRename(title);
  }

  return (
    <header class="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border-weak bg-surface px-3">
      <Show
        when={editing()}
        fallback={
          <button
            class="min-w-0 flex-1 cursor-text truncate border-0 bg-transparent text-left text-[13px] text-fg outline-none hover:text-accent"
            type="button"
            onClick={beginEdit}
            title="Rename chat"
          >
            {props.thread()?.title ?? "Chat"}
          </button>
        }
      >
        <input
          class="min-w-0 flex-1 truncate border-0 bg-transparent text-[13px] text-fg outline-none"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
            if (event.key === "Escape") setEditing(false);
          }}
          autofocus
        />
      </Show>
      <ContextWindowMeter usage={props.usage} />
      <Show when={props.availableProviders}>
        <ProviderModelPicker
          provider={activeProvider}
          availableProviders={providerList}
          onChange={(next) => props.onProviderChange?.(next)}
          disabled={props.inflight}
          modelsByKind={modelsByKind}
          activeModel={activeModel}
          onPickModel={handlePickModel}
          favorites={favoriteTuples}
          onToggleFavorite={handleToggleFavorite}
        />
      </Show>
      <Show when={showOpenInPicker()}>
        <span
          data-testid="chat-header-cwd-chip"
          class="inline-flex items-center gap-1 rounded-md border border-border-weak bg-surface px-1.5 py-0.5 text-[11px] text-fg-secondary"
          title={openInCwd() ?? ""}
        >
          <VscodeEntryIcon
            pathValue={openInCwd() ?? ""}
            kind="directory"
            class="size-3 text-[var(--fg-secondary)]"
          />
          <span class="max-w-32 truncate">{basename(openInCwd() ?? "")}</span>
        </span>
        <OpenInPicker
          availableEditors={availableEditors}
          preferredEditor={preferredEditor}
          openInCwd={openInCwd}
          onOpenInEditor={handleOpenInEditor}
          onPreferredEditorChange={handlePreferredEditorChange}
          favoriteShortcutLabel={
            props.openInFavoriteShortcutLabel
              ? () => props.openInFavoriteShortcutLabel!()
              : undefined
          }
        />
      </Show>
      <Show when={props.sessionName()}>
        {(session) => (
          <span class="inline-flex items-center rounded-md border border-border-weak px-1.5 py-0.5 text-[11px] text-dim">
            {session()}
          </span>
        )}
      </Show>
      <Show when={props.stopReason()}>
        {(reason) => (
          <span class="inline-flex items-center rounded-md border border-border-weak px-1.5 py-0.5 text-[11px] text-dim">
            {reason().replaceAll("_", " ")}
          </span>
        )}
      </Show>
      <Show when={props.inflight()}>
        <button
          class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-fg-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
          type="button"
          onClick={props.onCancel}
        >
          Stop
        </button>
      </Show>
      <Show when={props.onDelete}>
        {(onDelete) => (
          <button
            data-testid="chat-header-delete"
            class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-fg-secondary hover:border-red/60 hover:text-red"
            type="button"
            onClick={onDelete()}
            title="Delete this thread"
            aria-label="Delete thread"
          >
            Delete
          </button>
        )}
      </Show>
      <Show when={props.onClose}>
        {(onClose) => (
          <button
            data-testid="chat-header-close"
            class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-fg-secondary hover:border-accent hover:text-accent"
            type="button"
            onClick={onClose()}
          >
            Close
          </button>
        )}
      </Show>
    </header>
  );
}
