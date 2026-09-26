/* @jsxImportSource @opentui/solid */
import { For } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { OverlayFrame } from "./overlay-frame.tsx";
import { OverlayListRow } from "./overlay-list-row.tsx";
import { overlaySurfaceMetrics } from "./overlay-model.ts";

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
  viewportOrigin?: Readonly<{ x: number; y: number }>;
  zIndex?: number;
  active?: boolean;
  footer?: string;
  onDismiss?: () => void;
  onHighlight?: (id: string) => void;
  onSelect: (id: string) => void;
}

export function Menu(props: MenuProps) {
  const preferredHeight = () =>
    props.items.length + (props.title ? 1 : 0) + (props.footer ? 1 : 0) + 2;
  const metrics = () =>
    overlaySurfaceMetrics({
      viewportWidth: props.viewportWidth ?? Math.max(props.width, props.left + props.width),
      viewportHeight:
        props.viewportHeight ?? Math.max(preferredHeight(), props.top + preferredHeight()),
      preferredWidth: props.width,
      preferredHeight: preferredHeight(),
    });
  const innerWidth = () => metrics().contentWidth;
  return (
    <OverlayFrame
      theme={props.theme}
      viewportWidth={props.viewportWidth ?? Math.max(props.width, props.left + props.width)}
      viewportHeight={
        props.viewportHeight ?? Math.max(preferredHeight(), props.top + preferredHeight())
      }
      width={props.width}
      height={preferredHeight()}
      viewportOrigin={props.viewportOrigin}
      placement="anchor"
      anchor={{ x: props.left, y: props.top }}
      zIndex={props.zIndex ?? 20}
      active={props.active}
      title={props.title}
      footer={props.footer}
      onDismiss={props.onDismiss}
    >
      <For each={props.items.map((item) => item.id)}>
        {(id) => {
          const item = () => props.items.find((item) => item.id === id)!;
          const selected = () => props.selectedId === id;
          return (
            <OverlayListRow
              theme={props.theme}
              id={id}
              label={item().label}
              width={innerWidth()}
              shortcut={item().shortcut}
              selected={selected()}
              reserveMarker
              disabled={item().disabled || props.active === false}
              danger={item().danger}
              onHighlight={() => props.onHighlight?.(id)}
              onPress={() => props.onSelect(id)}
            />
          );
        }}
      </For>
    </OverlayFrame>
  );
}
