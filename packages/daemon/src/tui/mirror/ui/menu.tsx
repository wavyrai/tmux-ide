/* @jsxImportSource @opentui/solid */
import { For } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
}

export interface MenuProps {
  theme: SemanticThemeSnapshot;
  title?: string;
  items: readonly MenuItem[];
  selectedId: string | null;
  left: number;
  top: number;
  width: number;
  zIndex?: number;
  onSelect: (id: string) => void;
}

export function Menu(props: MenuProps) {
  const innerWidth = () => Math.max(1, props.width - 2);
  const itemLabel = (item: MenuItem) => {
    const shortcut = item.shortcut ? ` ${item.shortcut}` : "";
    const labelWidth = Math.max(1, innerWidth() - terminalDisplayWidth(shortcut) - 2);
    const label = clipTerminal(item.label, labelWidth);
    const gap = Math.max(1, labelWidth - terminalDisplayWidth(label));
    return ` ${label}${" ".repeat(gap)}${shortcut}`;
  };
  return (
    <box
      id="ui-menu"
      position="absolute"
      left={props.left}
      top={props.top}
      width={props.width}
      height={props.items.length + (props.title ? 3 : 2)}
      zIndex={props.zIndex ?? 20}
      border
      borderStyle="rounded"
      borderColor={props.theme.roles.borders.focused}
      backgroundColor={props.theme.roles.surfaces.panelRaised}
      flexDirection="column"
      overflow="hidden"
      onMouseDown={(event) => event.stopPropagation()}
    >
      {props.title ? (
        <text
          height={1}
          fg={props.theme.roles.text.primary}
          bg={props.theme.roles.surfaces.panelRaised}
          content={clipTerminal(` ${props.title}`, innerWidth())}
        />
      ) : null}
      <For each={props.items}>
        {(item) => {
          const selected = () => props.selectedId === item.id;
          return (
            <text
              id={`ui-menu-item:${item.id}`}
              height={1}
              width={innerWidth()}
              overflow="hidden"
              content={`${selected() ? "›" : " "}${itemLabel(item)}`}
              fg={
                item.disabled
                  ? props.theme.roles.text.muted
                  : item.danger
                    ? props.theme.roles.statusTone.warning
                    : selected()
                      ? props.theme.roles.selection.selectionText
                      : props.theme.roles.text.secondary
              }
              bg={
                selected()
                  ? props.theme.roles.selection.selection
                  : props.theme.roles.surfaces.panelRaised
              }
              onMouseDown={(event) => {
                if (event.button !== 0 || item.disabled) return;
                event.stopPropagation();
                props.onSelect(item.id);
              }}
            />
          );
        }}
      </For>
    </box>
  );
}
