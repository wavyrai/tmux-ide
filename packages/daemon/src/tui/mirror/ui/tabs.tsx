/* @jsxImportSource @opentui/solid */
import { For, Show, createMemo } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { Button } from "./button.tsx";
import { componentPalette } from "./state.ts";

export interface TabItem {
  id: string;
  label: string;
  marker?: string;
  badge?: string;
  attention?: boolean;
  disabled?: boolean;
}

export interface TabsProps {
  theme: SemanticThemeSnapshot;
  items: readonly TabItem[];
  activeId: string | null;
  hoveredId?: string | null;
  width?: number;
  fit?: "content" | "equal";
  addLabel?: string;
  onSelect: (id: string) => void;
  onAdd?: () => void;
}

function tabText(item: TabItem): string {
  const marker = item.marker ? `${item.marker} ` : "";
  const badge = item.badge ? ` ${item.badge}` : "";
  return ` ${marker}${item.label}${badge} `;
}

export function Tabs(props: TabsProps) {
  const itemIds = createMemo(() => props.items.map((item) => item.id), undefined, {
    equals: (previous, next) =>
      previous.length === next.length && previous.every((id, index) => id === next[index]),
  });
  const itemById = (id: string) => props.items.find((item) => item.id === id)!;
  const addWidth = () => (props.onAdd ? terminalDisplayWidth(props.addLabel ?? "+") + 2 : 0);
  const equalWidth = () =>
    Math.max(
      1,
      Math.min(32, Math.floor(((props.width ?? 0) - addWidth()) / Math.max(1, props.items.length))),
    );
  const itemWidth = (item: TabItem) =>
    props.fit === "equal" && props.width ? equalWidth() : terminalDisplayWidth(tabText(item));
  return (
    <box
      id="ui-tabs"
      width={props.width}
      height={1}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={props.theme.roles.surfaces.panel}
    >
      <For each={itemIds()}>
        {(id) => {
          const item = () => itemById(id);
          const active = () => id === props.activeId;
          const palette = () =>
            componentPalette(props.theme, {
              selected: active(),
              hovered: id === props.hoveredId,
              attention: item().attention,
              disabled: item().disabled,
            });
          return (
            <box
              id={`ui-tab:${id}`}
              height={1}
              width={itemWidth(item())}
              backgroundColor={palette().background}
              overflow="hidden"
              onMouseDown={(event) => {
                if (event.button !== 0 || item().disabled) return;
                event.stopPropagation();
                props.onSelect(id);
              }}
            >
              <text
                fg={palette().foreground}
                bg={palette().background}
                attributes={active() ? 1 : 0}
              >
                {clipTerminal(tabText(item()), itemWidth(item()))}
              </text>
            </box>
          );
        }}
      </For>
      <Show when={props.onAdd}>
        <box flexGrow={props.width ? 1 : 0} />
        <Button
          theme={props.theme}
          label={props.addLabel ?? "+"}
          variant="ghost"
          size="compact"
          width={addWidth()}
          background={props.theme.roles.surfaces.panel}
          onPress={props.onAdd}
        />
      </Show>
    </box>
  );
}
