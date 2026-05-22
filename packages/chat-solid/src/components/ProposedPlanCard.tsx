/**
 * Markdown-body card for a `chat.plan.upserted` proposed plan. Mirrors
 * the upstream surface (separate from `PlanCard.tsx`, which is the
 * editable plan-steps card used for the inline plan widget).
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │  [Plan] Implement OAuth                       ⋯     │
 *   ├─────────────────────────────────────────────────────┤
 *   │  # Implement OAuth                                   │
 *   │  - step a                                            │
 *   │  - step b                                            │
 *   │  ...                                                 │
 *   │                                                     │
 *   │              [ Expand plan ]                         │
 *   └─────────────────────────────────────────────────────┘
 *
 * Surfaces a collapse/expand affordance when the body is long
 * (> 900 chars OR > 20 lines), and an overflow menu with:
 *   - Copy to clipboard
 *   - Download as markdown (browser download)
 *   - Save to workspace (host callback)
 *
 * The host owns the workspace write (chat-solid stays out of the
 * filesystem API). When `onSaveToWorkspace` is omitted the menu
 * entry disables itself with a hint tooltip.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";
import { renderMarkdown } from "../lib/markdown";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  isProposedPlanCollapsible,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../lib/proposedPlan";

export interface ProposedPlanCardProps {
  planMarkdown: Accessor<string>;
  /** Optional workspace root surfaced in the save dialog hint. */
  workspaceRoot?: Accessor<string | null>;
  /** Project dir for markdown relative-link resolution. */
  cwd?: Accessor<string | undefined>;
  /**
   * Host wires the workspace write. Receives the path the user
   * typed (relative to workspaceRoot) and the normalized markdown
   * contents. Throw to surface an error in the dialog footer.
   * When omitted, the "Save to workspace" menu entry stays
   * disabled.
   */
  onSaveToWorkspace?: (relativePath: string, contents: string) => Promise<void>;
  /** Optional alternative to the default browser download. */
  onDownload?: (filename: string, contents: string) => void;
  /** Optional clipboard hook — defaults to navigator.clipboard. */
  onCopy?: (contents: string) => Promise<void>;
}

const CARD_CLASS =
  "rounded-lg border border-[var(--border)] bg-[var(--bg-weak,var(--surface))] p-3 sm:p-4";

const MENU_TRIGGER_CLASS =
  "inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

const MENU_POPUP_CLASS =
  "absolute right-0 top-[calc(100%+0.25rem)] z-30 min-w-48 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-elevated,var(--bg-strong))] shadow-2xl";

const MENU_ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-3 py-1.5 text-left text-base text-[var(--fg)] hover:bg-[var(--surface-hover,var(--surface))] disabled:cursor-not-allowed disabled:opacity-50";

const DIALOG_OVERLAY_CLASS = "fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4";

const DIALOG_PANEL_CLASS =
  "w-full max-w-md rounded-md border border-[var(--border)] bg-[var(--surface-elevated,var(--bg))] p-4 shadow-2xl";

const PRIMARY_BUTTON_CLASS =
  "inline-flex h-8 cursor-pointer items-center rounded-md border border-transparent bg-[var(--accent)] px-3 text-base font-medium text-[var(--bg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

const SECONDARY_BUTTON_CLASS =
  "inline-flex h-8 cursor-pointer items-center rounded-md border border-[var(--border)] bg-transparent px-3 text-base text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed";

async function defaultCopy(contents: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(contents);
    return;
  }
  throw new Error("Clipboard not available");
}

export function ProposedPlanCard(props: ProposedPlanCardProps): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuTrigger, setMenuTrigger] = createSignal<HTMLButtonElement>();
  const [menuPopup, setMenuPopup] = createSignal<HTMLDivElement>();
  const [copied, setCopied] = createSignal(false);
  const [saveDialogOpen, setSaveDialogOpen] = createSignal(false);
  const [savePath, setSavePath] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  const title = createMemo(() => proposedPlanTitle(props.planMarkdown()) ?? "Proposed plan");
  const canCollapse = createMemo(() => isProposedPlanCollapsible(props.planMarkdown()));
  const displayedMarkdown = createMemo(() => stripDisplayedPlanMarkdown(props.planMarkdown()));
  const collapsedPreview = createMemo(() =>
    canCollapse() ? buildCollapsedProposedPlanPreviewMarkdown(props.planMarkdown()) : null,
  );
  const downloadFilename = createMemo(() =>
    buildProposedPlanMarkdownFilename(props.planMarkdown()),
  );
  const exportContents = createMemo(() => normalizePlanMarkdownForExport(props.planMarkdown()));

  const bodyMarkdown = createMemo(() =>
    canCollapse() && !expanded() ? (collapsedPreview() ?? "") : displayedMarkdown(),
  );
  const bodyHtml = createMemo(() => renderMarkdown(bodyMarkdown(), { cwd: props.cwd?.() }));

  function closeMenu(): void {
    setMenuOpen(false);
  }

  function toggleMenu(): void {
    setMenuOpen((value) => !value);
  }

  function onDocPointer(event: PointerEvent): void {
    const triggerEl = menuTrigger();
    const popupEl = menuPopup();
    if (event.target instanceof Node) {
      if (popupEl?.contains(event.target)) return;
      if (triggerEl?.parentElement?.contains(event.target)) return;
    }
    closeMenu();
  }

  function onDocKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      closeMenu();
      if (saveDialogOpen() && !saving()) {
        setSaveDialogOpen(false);
      }
    }
  }

  createEffect(
    on(menuOpen, (isOpen) => {
      if (!isOpen) return;
      document.addEventListener("pointerdown", onDocPointer);
      document.addEventListener("keydown", onDocKey);
      onCleanup(() => {
        document.removeEventListener("pointerdown", onDocPointer);
        document.removeEventListener("keydown", onDocKey);
      });
    }),
  );

  createEffect(
    on(saveDialogOpen, (isOpen) => {
      if (!isOpen) return;
      document.addEventListener("keydown", onDocKey);
      onCleanup(() => document.removeEventListener("keydown", onDocKey));
    }),
  );

  async function handleCopy(): Promise<void> {
    closeMenu();
    try {
      const copy = props.onCopy ?? defaultCopy;
      await copy(exportContents());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  function handleDownload(): void {
    closeMenu();
    const filename = downloadFilename();
    const contents = exportContents();
    if (props.onDownload) {
      props.onDownload(filename, contents);
      return;
    }
    downloadPlanAsTextFile(filename, contents);
  }

  function openSaveDialog(): void {
    closeMenu();
    setSaveError(null);
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename()));
    setSaveDialogOpen(true);
  }

  async function handleSave(): Promise<void> {
    const trimmed = savePath().trim();
    if (!trimmed) {
      setSaveError("Enter a workspace path.");
      return;
    }
    if (!props.onSaveToWorkspace) return;
    setSaving(true);
    setSaveError(null);
    try {
      await props.onSaveToWorkspace(trimmed, exportContents());
      setSaveDialogOpen(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const canSave = (): boolean => typeof props.onSaveToWorkspace === "function";

  return (
    <section data-testid="proposed-plan-card" class={CARD_CLASS}>
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span
            class="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-xs uppercase tracking-[0.08em] text-[var(--fg-secondary)]"
            aria-hidden="true"
          >
            Plan
          </span>
          <p
            data-testid="proposed-plan-card-title"
            class="m-0 truncate text-md font-medium text-[var(--fg)]"
          >
            {title()}
          </p>
        </div>
        <div class="relative">
          <button
            ref={setMenuTrigger}
            type="button"
            data-testid="proposed-plan-card-menu-trigger"
            data-open={menuOpen() ? "true" : "false"}
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            aria-label="Plan actions"
            class={MENU_TRIGGER_CLASS}
            onClick={toggleMenu}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          <Show when={menuOpen()}>
            <div
              ref={setMenuPopup}
              data-testid="proposed-plan-card-menu"
              role="menu"
              class={MENU_POPUP_CLASS}
            >
              <button
                type="button"
                role="menuitem"
                data-testid="proposed-plan-card-copy"
                class={MENU_ITEM_CLASS}
                onClick={() => void handleCopy()}
              >
                {copied() ? "Copied!" : "Copy to clipboard"}
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="proposed-plan-card-download"
                class={MENU_ITEM_CLASS}
                onClick={handleDownload}
              >
                Download as markdown
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="proposed-plan-card-save"
                class={MENU_ITEM_CLASS}
                disabled={!canSave()}
                onClick={openSaveDialog}
                title={
                  canSave() ? "Save to workspace" : "Host has not wired a workspace save handler"
                }
              >
                Save to workspace
              </button>
            </div>
          </Show>
        </div>
      </header>

      <div class="relative mt-3">
        <div
          data-testid="proposed-plan-card-body"
          data-collapsed={canCollapse() && !expanded() ? "true" : "false"}
          class={canCollapse() && !expanded() ? "relative max-h-72 overflow-hidden" : "relative"}
        >
          <div
            class="chat-solid-markdown chat-markdown text-md leading-relaxed text-[var(--fg)]"
            innerHTML={bodyHtml()}
          />
          <Show when={canCollapse() && !expanded()}>
            <div
              aria-hidden="true"
              data-testid="proposed-plan-card-fade"
              class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--bg-weak,var(--surface))] to-transparent"
            />
          </Show>
        </div>

        <Show when={canCollapse()}>
          <div class="mt-3 flex justify-center">
            <button
              type="button"
              data-testid="proposed-plan-card-toggle"
              data-expanded={expanded() ? "true" : "false"}
              class={SECONDARY_BUTTON_CLASS}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded() ? "Collapse plan" : "Expand plan"}
            </button>
          </div>
        </Show>
      </div>

      <Show when={saveDialogOpen()}>
        <div
          data-testid="proposed-plan-card-save-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="proposed-plan-card-save-title"
          class={DIALOG_OVERLAY_CLASS}
          onClick={(event) => {
            if (event.target === event.currentTarget && !saving()) {
              setSaveDialogOpen(false);
            }
          }}
        >
          <div class={DIALOG_PANEL_CLASS}>
            <h3
              id="proposed-plan-card-save-title"
              class="m-0 text-md font-semibold text-[var(--fg)]"
            >
              Save plan to workspace
            </h3>
            <p class="mt-1 text-base text-[var(--dim)]">
              Enter a path relative to{" "}
              <code class="rounded bg-[var(--surface)] px-1 py-0.5 font-mono text-sm text-[var(--fg-secondary)]">
                {props.workspaceRoot?.() ?? "the workspace"}
              </code>
              .
            </p>
            <label class="mt-3 flex flex-col gap-1.5">
              <span class="text-xs uppercase tracking-[0.08em] text-[var(--dim)]">
                Workspace path
              </span>
              <input
                data-testid="proposed-plan-card-save-input"
                type="text"
                value={savePath()}
                disabled={saving()}
                spellcheck={false}
                placeholder={downloadFilename()}
                onInput={(event) => setSavePath(event.currentTarget.value)}
                class="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-base text-[var(--fg)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <Show when={saveError()}>
              {(error) => (
                <p
                  data-testid="proposed-plan-card-save-error"
                  class="mt-2 text-sm text-[var(--red,#c33)]"
                >
                  {error()}
                </p>
              )}
            </Show>
            <div class="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="proposed-plan-card-save-cancel"
                class={SECONDARY_BUTTON_CLASS}
                disabled={saving()}
                onClick={() => setSaveDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="proposed-plan-card-save-submit"
                class={PRIMARY_BUTTON_CLASS}
                disabled={saving()}
                onClick={() => void handleSave()}
              >
                {saving() ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
