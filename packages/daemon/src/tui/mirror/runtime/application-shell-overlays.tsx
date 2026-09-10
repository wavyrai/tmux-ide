import { ApplicationFleetSessionActions } from "./application-fleet-session-actions.tsx";
import { ApplicationPalettePreview } from "./application-palette-preview.tsx";
/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { For, Show, createMemo, createSignal, createEffect } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, clipTerminalEnd } from "../terminal-text.ts";
import { Badge } from "../ui/badge.tsx";
import { KeyHint } from "../ui/key-hint.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";
import { applicationMachineAuthorityManager } from "./application-machine-authority.ts";
import { Dialog } from "../ui/dialog.tsx";
import { OverlayFrame } from "../ui/overlay-frame.tsx";
import { overlayFrameSize } from "../ui/overlay-model.ts";
import { OverlayListRow } from "../ui/overlay-list-row.tsx";
import { TuiButton } from "../ui/button.tsx";
import { applicationCommandDescription } from "../workspace/application-command-description.ts";
import type { ApplicationPaneRenameDraft } from "./application-pane-rename-input.ts";
import type { ApplicationPaletteCommand } from "./application-palette-input.ts";

export function PaneRenameDialog(props: {
  readonly draft: ApplicationPaneRenameDraft;
  readonly width: number;
  readonly height: number;
  readonly theme: SemanticThemeSnapshot;
  readonly onCancel: () => void;
  readonly onSubmit?: () => void;
  readonly active?: boolean;
  readonly zIndex?: number;
}): JSX.Element {
  const width = () => Math.max(1, Math.min(52, props.width - (props.width >= 8 ? 4 : 0)));
  const fieldWidth = () => Math.max(1, width() - 4);
  return (
    <Dialog
      theme={props.theme}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={width()}
      height={8}
      title="Rename pane"
      footer="Enter save · Esc cancel"
      active={props.active}
      zIndex={props.zIndex}
      onDismiss={props.onCancel}
    >
      <text height={1} fg={props.theme.roles.text.muted} content="Pane name" />
      <text
        width={fieldWidth()}
        overflow="hidden"
        fg={props.theme.roles.text.link}
        content={clipTerminalEnd(`${props.draft.value}▏`, fieldWidth())}
      />
      <text
        height={1}
        width={fieldWidth()}
        fg={props.theme.roles.text.muted}
        content={clipTerminal(
          props.draft.value.trim()
            ? "Ctrl+U clear · 80 characters maximum"
            : "Enter a name to save",
          fieldWidth(),
        )}
      />
      <box height={1} flexDirection="row" gap={1}>
        <TuiButton
          theme={props.theme}
          label="Save"
          size="compact"
          variant="primary"
          disabled={props.active === false || !props.draft.value.trim()}
          onPress={props.onSubmit}
        />
        <TuiButton
          theme={props.theme}
          label="Cancel"
          size="compact"
          disabled={props.active === false}
          onPress={props.onCancel}
        />
      </box>
    </Dialog>
  );
}

export function MinimalPalette(props: {
  readonly width: number;
  readonly height: number;
  readonly selected: number;
  readonly query?: string;
  readonly title?: string;
  readonly onViewport?: (rows: number) => void;
  readonly onFavorite?: (command: ApplicationPaletteCommand) => void;
  readonly keyboardHint?: string;
  readonly previewActive?: boolean;
  readonly onModalChange?: (open: boolean) => void;
  readonly disabledReason?: (command: ApplicationPaletteCommand) => string | null;
  readonly onSelect?: (index: number) => void;
  readonly closeArmed: boolean;
  readonly commands: readonly ApplicationPaletteCommand[];
  readonly theme: SemanticThemeSnapshot;
  readonly onActivate: (command: ApplicationPaletteCommand) => void;
  readonly onClose: () => void;
  readonly active?: boolean;
  readonly zIndex?: number;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const [modal, setModal] = createSignal(false);
  const [lastHost, setLastHost] = createSignal<ApplicationPaletteCommand>();
  createEffect(() => {
    const c = props.commands[props.selected];
    if (typeof c === "object" && c.fleet)
      setLastHost({
        kind: "open-machine",
        sessionName: "",
        label: c.fleet.hostLabel,
        fleet: { ...c.fleet, liveSessionId: "", favorite: undefined },
      });
  });
  const selectedCommand = () =>
    props.commands[props.selected] ?? (props.query ? lastHost() : undefined);
  const hasPreview = () => {
    const c = selectedCommand();
    return typeof c === "object" && !!c.fleet && props.height >= 18;
  };
  createEffect(() => {
    if (!hasPreview()) setExpanded(false);
  });
  const horizontalInset = () => (props.width >= 8 ? 2 : 0);
  const verticalInset = () => (props.height >= 10 ? 1 : 0);
  const width = () =>
    Math.max(1, Math.min(hasPreview() ? 132 : 72, props.width - horizontalInset() * 2));
  const height = () =>
    overlayFrameSize({
      viewportWidth: props.width,
      viewportHeight: props.height,
      preferredWidth: width(),
      preferredHeight: Math.max(
        3,
        Math.min(
          hasPreview() ? 36 : 20,
          Math.max(hasPreview() ? 22 : 9, props.commands.length + 6),
          props.height - verticalInset() * 2,
        ),
      ),
    }).height;
  const innerWidth = () => Math.max(1, width() - 4);
  const commandLabel = (command: ApplicationPaletteCommand): string => {
    return props.closeArmed && command === "close-pane"
      ? "Confirm close pane"
      : applicationCommandDescription(command).label;
  };
  const sideBySide = () => hasPreview() && width() >= 100 && !expanded();
  const bodyHeight = () =>
    Math.max(
      1,
      height() - (height() >= 9 ? 6 : 4) - (height() >= 12 ? 1 : 0) - (hasPreview() ? 2 : 0),
    );
  const listWidth = () => (sideBySide() ? Math.floor((innerWidth() - 3) * 0.48) : innerWidth());
  const previewWidth = () => (sideBySide() ? innerWidth() - listWidth() - 3 : innerWidth());
  const previewHeight = () =>
    !hasPreview()
      ? 0
      : sideBySide() || expanded()
        ? bodyHeight()
        : Math.max(4, Math.floor(bodyHeight() * 0.55));
  const visibleCapacity = () =>
    expanded() ? 0 : sideBySide() ? bodyHeight() : Math.max(1, bodyHeight() - previewHeight());
  createEffect(() => props.onViewport?.(Math.max(1, visibleCapacity())));
  const favorite = () => {
    const c = selectedCommand();
    return typeof c === "object" && c.kind === "open-session" ? c.fleet?.favorite : undefined;
  };
  useKeyboardRoute((event) => {
    if (
      modal() ||
      props.active === false ||
      props.previewActive === false ||
      !event.ctrl ||
      event.meta
    )
      return false;
    const key = event.name.toLowerCase();
    if (!["f", "r"].includes(key)) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.eventType !== "press") return true;
    const c = selectedCommand();
    if (c && key === "f") props.onFavorite?.(c);
    if (typeof c === "object" && c.fleet && key === "r")
      applicationMachineAuthorityManager.retry(c.fleet.machineId);
    return true;
  });
  const firstVisible = createMemo((previous: number) => {
    const capacity = visibleCapacity();
    const next =
      props.selected < previous
        ? props.selected
        : props.selected >= previous + capacity
          ? props.selected - capacity + 1
          : previous;
    return Math.max(0, Math.min(next, props.commands.length - capacity));
  }, 0);
  const commandRows = () =>
    props.commands
      .slice(firstVisible(), firstVisible() + visibleCapacity())
      .map((command, offset) => {
        const index = firstVisible() + offset;
        return {
          command,
          index,
        };
      });
  return (
    <Dialog
      theme={props.theme}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={width()}
      height={height()}
      title={props.title ?? (innerWidth() >= 15 ? "Command palette" : "Commands")}
      {...(height() >= 9
        ? { footer: props.keyboardHint ?? "↑↓ choose · Enter run · Esc close" }
        : {})}
      active={props.active}
      zIndex={props.zIndex}
      onDismiss={props.onClose}
    >
      <text
        height={1}
        width={innerWidth()}
        fg={props.theme.roles.text.link}
        content={clipTerminal(
          props.query
            ? `/ ${clipTerminalEnd(`${props.query}▏`, innerWidth() - 2)}`
            : "/ Search commands…",
          innerWidth(),
        )}
      />
      <Show when={height() >= 12}>
        <box height={1} flexDirection="row" gap={1} overflow="hidden">
          <Badge theme={props.theme} label={`${props.commands.length} matches`} />
          <Show when={hasPreview()}>
            <Badge theme={props.theme} label="PASSIVE PREVIEW" tone="neutral" />
          </Show>
        </box>
      </Show>
      <box
        height={bodyHeight()}
        flexDirection={sideBySide() ? "row" : "column"}
        gap={sideBySide() ? 1 : 0}
        overflow="hidden"
      >
        <Show when={!expanded()}>
          <box
            width={listWidth()}
            height={visibleCapacity()}
            flexDirection="column"
            overflow="hidden"
            onMouseScroll={(event) => {
              if (props.active === false || !props.commands.length) return;
              event.preventDefault();
              event.stopPropagation();
              props.onSelect?.(
                Math.max(
                  0,
                  Math.min(
                    props.commands.length - 1,
                    props.selected + (event.scroll?.direction === "up" ? -1 : 1),
                  ),
                ),
              );
            }}
          >
            <Show
              when={props.commands.length > 0}
              fallback={
                <text
                  height={1}
                  width={innerWidth()}
                  fg={props.theme.roles.text.muted}
                  content={clipTerminal("No matches · Ctrl+U clear", innerWidth())}
                />
              }
            >
              <For each={commandRows().map((row) => applicationCommandDescription(row.command).id)}>
                {(id) => {
                  const row = () =>
                    commandRows().find(
                      (row) => applicationCommandDescription(row.command).id === id,
                    )!;
                  return (
                    <OverlayListRow
                      theme={props.theme}
                      id={id}
                      label={`${typeof row().command === "object" && (row().command as { fleet?: { favorite?: boolean } }).fleet?.favorite ? "★ " : ""}${commandLabel(row().command)}`}
                      query={props.query}
                      width={listWidth()}
                      selected={props.selected === row().index}
                      reserveMarker={innerWidth() >= 16}
                      disabled={
                        props.active === false || Boolean(props.disabledReason?.(row().command))
                      }
                      danger={props.closeArmed && row().command === "close-pane"}
                      onHighlight={() => props.onSelect?.(row().index)}
                      onPress={() => {
                        props.onSelect?.(row().index);
                        props.onActivate(row().command);
                      }}
                    />
                  );
                }}
              </For>
            </Show>
          </box>
        </Show>
        <Show when={sideBySide()}>
          <text
            width={1}
            height={bodyHeight()}
            fg={props.theme.roles.text.muted}
            content={Array(bodyHeight()).fill("│").join("\n")}
          />
        </Show>
        <Show when={hasPreview()}>
          <ApplicationPalettePreview
            command={selectedCommand()}
            width={previewWidth()}
            height={previewHeight()}
            theme={props.theme}
            active={!modal() && props.active !== false && props.previewActive !== false}
            onExpandedChange={setExpanded}
          />
        </Show>
      </box>
      <Show when={hasPreview()}>
        <box height={2} flexDirection="row" gap={1} overflow="hidden">
          <ApplicationFleetSessionActions
            command={selectedCommand()}
            width={props.width}
            height={props.height}
            theme={props.theme}
            initialName={props.commands.length === 0 ? props.query : undefined}
            active={props.active !== false && props.previewActive !== false}
            onModalChange={(open) => {
              setModal(open);
              props.onModalChange?.(open);
            }}
          />
          <Show when={favorite() !== undefined && props.onFavorite}>
            <KeyHint
              theme={props.theme}
              keys="^F"
              label={favorite() ? "Unfavorite" : "Favorite"}
              disabled={props.active === false || props.previewActive === false}
              onPress={() => {
                const c = selectedCommand();
                if (c) props.onFavorite?.(c);
              }}
            />
          </Show>
        </box>
      </Show>
      <Show when={height() >= 9}>
        <text
          height={1}
          width={innerWidth()}
          fg={props.theme.roles.text.muted}
          content={clipTerminal(
            (() => {
              const command = props.commands[props.selected];
              if (!command) return "Try an action, agent or session name";
              return (
                props.disabledReason?.(command) ??
                (props.closeArmed
                  ? "Closes the pane and its running process"
                  : `${props.selected + 1}/${props.commands.length} · ${applicationCommandDescription(command).detail}`)
              );
            })(),
            innerWidth(),
          )}
        />
      </Show>
    </Dialog>
  );
}

export function NotificationToast(props: {
  readonly note: string;
  readonly width: number;
  readonly height: number;
  readonly theme: SemanticThemeSnapshot;
  readonly active: boolean;
  readonly zIndex: number;
  readonly onDismiss?: () => void;
}): JSX.Element {
  const width = () => Math.max(18, Math.min(52, props.width - (props.width >= 8 ? 4 : 0)));
  return (
    <OverlayFrame
      theme={props.theme}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={width()}
      height={3}
      placement="top-right"
      modal={false}
      active={props.active}
      zIndex={props.zIndex}
    >
      <OverlayListRow
        theme={props.theme}
        id="notification"
        label={props.note}
        {...(props.onDismiss ? { shortcut: "×" } : {})}
        width={Math.max(1, width() - 2)}
        onPress={() => props.onDismiss?.()}
      />
    </OverlayFrame>
  );
}

import type { ApplicationAppearanceOwner } from "./application-appearance-owner.ts";
import type { OverlayLayer } from "../ui/overlay-host.tsx";

export function appearanceDialogLayer(
  owner: ApplicationAppearanceOwner | undefined,
  width: number,
  height: number,
): OverlayLayer[] {
  if (!owner?.pickerOpen()) return [];
  return [
    {
      id: "appearance",
      render: ({ active, zIndex }) => (
        <AppearanceDialog
          owner={owner}
          width={width}
          height={height}
          active={active}
          zIndex={zIndex}
        />
      ),
    },
  ];
}

export function AppearanceDialog(props: {
  owner: ApplicationAppearanceOwner;
  width: number;
  height: number;
  active?: boolean;
  zIndex?: number;
}) {
  const width = () => Math.max(1, Math.min(48, props.width - (props.width >= 8 ? 4 : 0)));
  return (
    <Dialog
      theme={props.owner.theme()}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={width()}
      height={Math.min(18, props.height)}
      title="Appearance"
      footer={width() < 40 ? "Enter save · Esc back" : "↑↓ preview · Enter save · Esc cancel"}
      active={props.active}
      zIndex={props.zIndex}
      onDismiss={props.owner.cancelPicker}
    >
      <text
        height={1}
        fg={props.owner.theme().roles.text.primary}
        content={`Search: ${props.owner.pickerQuery() || "type to filter"}`}
      />
      <For
        each={(() => {
          const options = props.owner.pickerOptions();
          const count = Math.max(1, Math.min(10, props.height - 8));
          const index = options.findIndex((p) => p.id === props.owner.pickerSelection());
          const start = Math.max(
            0,
            Math.min(index - Math.floor(count / 2), options.length - count),
          );
          return options.slice(start, start + count);
        })()}
      >
        {(option) => (
          <OverlayListRow
            theme={props.owner.theme()}
            id={option.id}
            label={option.name}
            width={Math.max(1, width() - 4)}
            selected={props.owner.pickerSelection() === option.id}
            disabled={props.active === false}
            onPress={() => props.owner.preview(option.id)}
          />
        )}
      </For>
      <text
        height={1}
        fg={props.owner.theme().roles.text.muted}
        content={
          props.owner.pickerError()
            ? width() < 40
              ? "Save failed · retry"
              : props.owner.pickerError()!
            : width() < 40
              ? "↑↓ preview"
              : "Preview now · Save to remember"
        }
      />
      <box height={1} flexDirection="row" gap={1}>
        <TuiButton
          theme={props.owner.theme()}
          label="Save"
          size="compact"
          variant="primary"
          disabled={props.active === false}
          onPress={props.owner.savePicker}
        />
        <TuiButton
          theme={props.owner.theme()}
          label="Cancel"
          size="compact"
          disabled={props.active === false}
          onPress={props.owner.cancelPicker}
        />
      </box>
    </Dialog>
  );
}
