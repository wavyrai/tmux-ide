/* @jsxImportSource @opentui/solid */
import { For } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { OverlayFrame } from "./overlay-frame.tsx";
import { OverlayListRow } from "./overlay-list-row.tsx";

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
  viewportWidth?: number;
  viewportHeight?: number;
  zIndex?: number;
  active?: boolean;
  onDismiss?: () => void;
  onSelect: (id: string) => void;
}

export function Menu(props: MenuProps) {
  const innerWidth = () => Math.max(1, props.width - 2);
  return (
    <OverlayFrame
      theme={props.theme}
      viewportWidth={props.viewportWidth ?? Math.max(props.width, props.left + props.width)}
      viewportHeight={props.viewportHeight ?? Math.max(3, props.top + props.items.length + 3)}
      width={props.width}
      height={props.items.length + (props.title ? 3 : 2)}
      placement="anchor"
      anchor={{ x: props.left, y: props.top }}
      zIndex={props.zIndex ?? 20}
      active={props.active}
      title={props.title}
      onDismiss={props.onDismiss}
    >
      <For each={props.items}>
        {(item) => {
          const selected = () => props.selectedId === item.id;
          return (
            <OverlayListRow
              theme={props.theme}
              id={item.id}
              label={item.label}
              width={innerWidth()}
              {...(item.shortcut ? { shortcut: item.shortcut } : {})}
              selected={selected()}
              {...(item.disabled !== undefined ? { disabled: item.disabled } : {})}
              {...(item.danger !== undefined ? { danger: item.danger } : {})}
              onPress={() => props.onSelect(item.id)}
            />
          );
        }}
      </For>
    </OverlayFrame>
  );
}
