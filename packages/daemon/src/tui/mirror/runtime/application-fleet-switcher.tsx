/* @jsxImportSource @opentui/solid */
import { For, Show, createSignal, createMemo, createEffect, onCleanup } from "solid-js";
import { createFleetPreviewOwner } from "./application-fleet-preview.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { Dialog } from "../ui/dialog.tsx";
import { NavigationRow } from "../ui/navigation-row.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";

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

/** Fleet selector with one optional passive snapshot; no terminal streams. */
export function ApplicationFleetSwitcher(props: {
  open: boolean;
  attentionOnly: boolean;
  rows: readonly FleetSwitcherRow[];
  onClose(): void;
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
}) {
  const [preview, setPreview] = createSignal<string | null>(null);
  const previewOwner = createFleetPreviewOwner(setPreview);
  onCleanup(previewOwner.dispose);
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<string | null>(null);
  const rows = createMemo(() => {
    const search = query().trim().toLocaleLowerCase();
    return props.rows.filter(
      (row) =>
        (!props.attentionOnly || row.attention) &&
        (!search || `${row.label} ${row.detail}`.toLocaleLowerCase().includes(search)),
    );
  });
  createEffect(() => {
    if (!rows().some((row) => row.key === selected())) setSelected(rows()[0]?.key ?? null);
  });
  const index = () =>
    Math.max(
      0,
      rows().findIndex((row) => row.key === selected()),
    );
  createEffect(() => {
    const row = rows()[index()];
    previewOwner.select(
      props.open && props.height >= 18 && !row?.disabled ? row?.preview : undefined,
      row?.previewKey ?? row?.key,
    );
  });
  const activate = () => {
    const row = rows()[index()];
    if (row && !row.disabled) {
      props.onClose();
      row.open();
    }
  };
  useKeyboardRoute((event) => {
    if (!props.open || event.eventType !== "press") return false;
    const key = event.name.toLowerCase();
    if (!["up", "down", "enter", "return", "escape"].includes(key) && !(event.ctrl && key === "f"))
      return false;
    event.preventDefault();
    event.stopPropagation();
    if (key === "escape") props.onClose();
    else if (key === "enter" || key === "return") activate();
    else if (event.ctrl && key === "f") rows()[index()]?.toggleFavorite();
    else
      setSelected(
        rows()[Math.max(0, Math.min(rows().length - 1, index() + (key === "up" ? -1 : 1)))]?.key ??
          null,
      );
    return true;
  });
  const width = () => Math.max(1, Math.min(90, props.width - 4));
  const height = () => Math.max(1, Math.min(22, props.height - 2));
  const capacity = () => Math.max(1, height() - 6 - (props.height >= 18 ? 6 : 0));
  const visible = () =>
    rows().slice(Math.max(0, index() - capacity() + 1), Math.max(capacity(), index() + 1));
  return (
    <Show when={props.open}>
      <Dialog
        theme={props.theme}
        viewportWidth={props.width}
        viewportHeight={props.height}
        width={width()}
        height={height()}
        title={
          props.attentionOnly ? "Agent attention across machines" : "Switch session across machines"
        }
        footer="↑↓ select · Enter open · Ctrl-F favorite · Esc close"
        active={true}
        zIndex={1000}
        onDismiss={props.onClose}
      >
        <input
          focused={true}
          width={Math.max(1, width() - 4)}
          value={query()}
          maxLength={255}
          placeholder="Search sessions, agents, machines…"
          onInput={(value) => {
            setQuery(value);
            setSelected(null);
          }}
          onSubmit={activate}
        />
        <text height={1} fg={props.theme.roles.text.muted}>{`${rows().length} matches`}</text>
        <For each={visible()}>
          {(row) => (
            <NavigationRow
              theme={props.theme}
              width={Math.max(1, width() - 4)}
              id={`fleet-switcher:${row.key}`}
              label={row.label}
              detail={row.disabled ? `${row.detail} · unavailable` : row.detail}
              marker={row.favorite ? "★" : row.attention ? "!" : " "}
              focused={rows()[index()]?.key === row.key}
              onActivate={() => {
                if (!row.disabled) {
                  props.onClose();
                  row.open();
                }
              }}
            />
          )}
        </For>
        <Show when={props.height >= 18 && preview() !== null}>
          <text height={1} fg={props.theme.roles.text.muted}>
            Read-only preview
          </text>
          <text height={5} fg={props.theme.roles.text.primary}>
            {preview()?.split("\n").slice(-5).join("\n")}
          </text>
        </Show>
        <Show when={rows().length === 0}>
          <text height={1} fg={props.theme.roles.text.muted}>
            No matching live or cached entries
          </text>
        </Show>
      </Dialog>
    </Show>
  );
}
