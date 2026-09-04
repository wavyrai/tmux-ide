/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { For } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { Dialog } from "../ui/dialog.tsx";
import { OverlayFrame } from "../ui/overlay-frame.tsx";
import { OverlayListRow } from "../ui/overlay-list-row.tsx";
import type { ApplicationPaneRenameDraft } from "./application-pane-rename-input.ts";
import type { ApplicationPaletteCommand } from "./application-palette-input.ts";

export function PaneRenameDialog(props: {
  readonly draft: ApplicationPaneRenameDraft;
  readonly width: number;
  readonly height: number;
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onCancel: () => void;
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
      height={7}
      title="Rename pane"
      footer="Enter save · Esc cancel"
      active={props.active}
      zIndex={props.zIndex}
      onDismiss={props.onCancel}
    >
      <text
        width={fieldWidth()}
        overflow="hidden"
        fg={props.theme.roles.text.link}
        content={clipTerminal(`${props.draft.value}▏`, fieldWidth())}
      />
    </Dialog>
  );
}

export function MinimalPalette(props: {
  readonly width: number;
  readonly height: number;
  readonly selected: number;
  readonly closeArmed: boolean;
  readonly commands: readonly ApplicationPaletteCommand[];
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onActivate: (command: ApplicationPaletteCommand) => void;
  readonly onClose: () => void;
  readonly active?: boolean;
  readonly zIndex?: number;
}): JSX.Element {
  const horizontalInset = () => (props.width >= 8 ? 2 : 0);
  const verticalInset = () => (props.height >= 6 ? 1 : 0);
  const width = () => Math.max(1, Math.min(58, props.width - horizontalInset() * 2));
  const height = () =>
    Math.max(3, Math.min(16, props.commands.length + 4, props.height - verticalInset() * 2));
  const innerWidth = () => Math.max(1, width() - 2);
  const commandLabel = (command: ApplicationPaletteCommand): string => {
    if (typeof command === "object")
      return command.kind === "open-session"
        ? `Open session · ${command.label}`
        : `Jump to ${command.label} · ${command.sessionName}`;
    if (command === "home")
      return `F1 Home${innerWidth() >= 32 ? " · sessions and agent state" : ""}`;
    if (command === "terminals")
      return `F2 Terminals${innerWidth() >= 32 ? " · control the live tmux session" : ""}`;
    if (command === "new-window") return "New terminal window";
    if (command === "split-right") return "Split pane right";
    if (command === "split-down") return "Split pane down";
    return props.closeArmed ? "Confirm close pane" : "Close pane…";
  };
  // OpenTUI clips the final row against the lower border at very small
  // viewports; retain the existing four-command 20x7 presentation while
  // scrolling longer agent lists only when they exceed the rendered body.
  const visibleCapacity = () => Math.max(1, height() - (height() >= 9 ? 4 : 3));
  const firstVisible = () =>
    Math.max(0, Math.min(props.selected, props.commands.length - visibleCapacity()));
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
      {...(height() >= 9 ? { footer: "↑↓ choose · Enter open · Esc close" } : {})}
      active={props.active}
      zIndex={props.zIndex}
      onDismiss={props.onClose}
    >
      <For each={commandRows()}>
        {(row) => (
          <OverlayListRow
            theme={props.theme}
            id={typeof row.command === "object" ? `agent:${row.command.paneId}` : row.command}
            label={commandLabel(row.command)}
            width={innerWidth()}
            selected={props.selected === row.index}
            danger={props.closeArmed && row.command === "close-pane"}
            onPress={() => props.onActivate(row.command)}
          />
        )}
      </For>
    </Dialog>
  );
}

export function NotificationToast(props: {
  readonly note: string;
  readonly width: number;
  readonly height: number;
  readonly theme: ApplicationShellViewProps["theme"];
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
