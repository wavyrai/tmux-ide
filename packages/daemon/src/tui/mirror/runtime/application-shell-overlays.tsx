/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, clipTerminalEnd } from "../terminal-text.ts";
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
  const horizontalInset = () => (props.width >= 8 ? 2 : 0);
  const verticalInset = () => (props.height >= 10 ? 1 : 0);
  const width = () => Math.max(1, Math.min(58, props.width - horizontalInset() * 2));
  const height = () =>
    overlayFrameSize({
      viewportWidth: props.width,
      viewportHeight: props.height,
      preferredWidth: width(),
      preferredHeight: Math.max(
        3,
        Math.min(16, Math.max(9, props.commands.length + 6), props.height - verticalInset() * 2),
      ),
    }).height;
  const innerWidth = () => Math.max(1, width() - 4);
  const commandLabel = (command: ApplicationPaletteCommand): string => {
    return props.closeArmed && command === "close-pane"
      ? "Confirm close pane"
      : applicationCommandDescription(command).label;
  };
  const visibleCapacity = () => Math.max(1, height() - (height() >= 9 ? 6 : 4));
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
      title={innerWidth() >= 15 ? "Command palette" : "Commands"}
      {...(height() >= 9 ? { footer: "↑↓ choose · Enter run · Esc close" } : {})}
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
      <box
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
                commandRows().find((row) => applicationCommandDescription(row.command).id === id)!;
              return (
                <OverlayListRow
                  theme={props.theme}
                  id={id}
                  label={commandLabel(row().command)}
                  width={innerWidth()}
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
