/* @jsxImportSource @opentui/solid */
import { Show, createSignal } from "solid-js";
import { createApplicationPaletteSearchOwner } from "./application-palette-search-owner.ts";
import { MinimalPalette } from "./application-shell-overlays.tsx";
import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { useKeyboardRoute, usePasteRoute } from "../ui/keyboard-router.tsx";

export interface FleetSwitcherRow {
  readonly key: string;
  readonly previewKey?: string;
  readonly label: string;
  readonly detail: string;
  readonly favorite: boolean;
  readonly attention: boolean;
  readonly disabled: boolean;
  readonly canFavorite: boolean;
  preview?(signal: AbortSignal): Promise<string>;
  open(): void;
  toggleFavorite(): void;
}

/** F6/F7 reuse the F5 surface, search owner, preview and exact-host actions. */
export function ApplicationFleetSwitcher(props: {
  open: boolean;
  attentionOnly: boolean;
  rows: readonly FleetSwitcherRow[];
  commands?: readonly ApplicationPaletteCommand[];
  onActivate?: (command: ApplicationPaletteCommand) => void;
  onFavorite?: (command: ApplicationPaletteCommand) => void;
  active?: boolean;
  onClose(): void;
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
}) {
  const [modal, setModal] = createSignal(false);
  const source = () =>
    props.commands ??
    props.rows.map(
      (r): ApplicationPaletteCommand => ({
        kind: "open-session",
        sessionName: r.key,
        label: `${r.label} · ${r.detail}`,
      }),
    );
  const fallbackRow = (c: ApplicationPaletteCommand) =>
    typeof c === "object" ? props.rows.find((r) => r.key === c.sessionName) : undefined;
  const commands = () =>
    source().filter(
      (c) =>
        !props.attentionOnly ||
        (props.commands
          ? typeof c === "object" &&
            c.kind === "jump-agent" &&
            !c.fleet?.disabled &&
            c.fleet?.agentActivities?.some((a) => a.paneId === c.paneId && a.attention)
          : fallbackRow(c)?.attention),
    );
  const disabled = (c: ApplicationPaletteCommand) =>
    typeof c === "object" && (c.fleet?.disabled || fallbackRow(c)?.disabled)
      ? "Unavailable · Ctrl-R retry host"
      : null;
  const activate = (c: ApplicationPaletteCommand) => {
    if (disabled(c)) return;
    props.onClose();
    if (props.onActivate) props.onActivate(c);
    else fallbackRow(c)?.open();
  };
  const favorite = (c: ApplicationPaletteCommand) =>
    props.onFavorite ? props.onFavorite(c) : fallbackRow(c)?.toggleFavorite();
  const search = createApplicationPaletteSearchOwner({
    commands,
    open: () => props.open && props.active !== false && !modal(),
    activate,
    close: props.onClose,
    onChange: () => {},
  });
  usePasteRoute((bytes) =>
    props.open && props.active !== false && !modal() ? search.handlePaste(bytes) : false,
  );
  useKeyboardRoute((event) => {
    if (!props.open || props.active === false || modal()) return false;
    const key = event.name.toLowerCase();
    // Preview and action components own these chords, without text or terminal leakage.
    if (event.ctrl && ["left", "right", "p", "e", "n", "x", "r"].includes(key)) return false;
    if (event.ctrl && key === "f") {
      event.preventDefault();
      event.stopPropagation();
      const c = search.commands()[search.selection()];
      if (event.eventType === "press" && c) favorite(c);
      return true;
    }
    const handled = search.handleKey(event);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
    return handled;
  });
  return (
    <Show when={props.open}>
      <MinimalPalette
        width={props.width}
        height={props.height}
        selected={search.selection()}
        title={
          props.attentionOnly ? "Agent attention across machines" : "Switch session across machines"
        }
        query={search.query()}
        keyboardHint={search.keyboardHint()}
        commands={search.commands()}
        closeArmed={false}
        theme={props.theme}
        active={props.active !== false}
        previewActive={props.active !== false}
        onSelect={search.select}
        onViewport={search.setViewport}
        onFavorite={favorite}
        disabledReason={disabled}
        onModalChange={setModal}
        onActivate={activate}
        onClose={props.onClose}
        zIndex={1000}
      />
    </Show>
  );
}
