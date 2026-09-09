/* @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { Dialog } from "../ui/dialog.tsx";
import { TuiButton } from "../ui/button.tsx";

export interface ApplicationAddMachineDialogProps {
  readonly open: boolean;
  readonly alias: string;
  readonly onAliasChange: (alias: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly error: string | null;
  readonly width: number;
  readonly height: number;
  readonly theme: SemanticThemeSnapshot;
}

/** Collects an SSH target only; the owner validates and opens the connection. */
export function ApplicationAddMachineDialog(props: ApplicationAddMachineDialogProps) {
  const width = () => Math.max(1, Math.min(58, props.width - (props.width >= 8 ? 4 : 0)));
  const contentWidth = () => Math.max(1, width() - 4);
  return (
    <Show when={props.open}>
      <Dialog
        theme={props.theme}
        viewportWidth={props.width}
        viewportHeight={props.height}
        width={width()}
        height={Math.min(10, Math.max(1, props.height))}
        title="Add machine"
        footer="Enter connect · Esc cancel"
        active={true}
        zIndex={1000}
        onDismiss={props.onCancel}
      >
        <text height={1} fg={props.theme.roles.text.primary}>
          SSH alias or user@host
        </text>
        <input
          id="application-add-machine-alias"
          width={contentWidth()}
          height={1}
          focused={true}
          backgroundColor={props.theme.roles.surfaces.panel}
          focusedBackgroundColor={props.theme.roles.surfaces.panel}
          textColor={props.theme.roles.text.primary}
          focusedTextColor={props.theme.roles.text.primary}
          placeholderColor={props.theme.roles.text.muted}
          maxLength={255}
          value={props.alias}
          placeholder="my-server"
          onInput={props.onAliasChange}
          onSubmit={() => {
            if (props.alias.trim()) props.onSubmit();
          }}
        />
        <text
          height={1}
          fg={props.theme.roles.text.muted}
          content={clipTerminal("Requires SSH key authentication and host trust.", contentWidth())}
        />
        <text
          height={1}
          fg={props.theme.roles.text.muted}
          content={clipTerminal("Start tmux-ide --headless on that machine first.", contentWidth())}
        />
        <text
          height={1}
          fg={props.theme.roles.text.primary}
          content={clipTerminal(props.error ?? "", contentWidth())}
        />
        <box height={1} flexDirection="row" gap={1}>
          <TuiButton
            theme={props.theme}
            label="Connect"
            size="compact"
            variant="primary"
            disabled={!props.alias.trim()}
            onPress={props.onSubmit}
          />
          <TuiButton theme={props.theme} label="Cancel" size="compact" onPress={props.onCancel} />
        </box>
      </Dialog>
    </Show>
  );
}
