/* @jsxImportSource @opentui/solid */
import { For, createMemo } from "solid-js";
import { useKeyboard } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { Button } from "./button.tsx";
import { componentPalette } from "./state.ts";

export interface TabItem {
  id: string;
  label: string;
  /** Exact cell projection for compound chrome that already owns responsive labels. */
  presentation?: string;
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
  focusedId?: string | null;
  focused?: boolean;
  width?: number;
  fit?: "content" | "equal";
  variant?: "panel" | "header";
  addLabel?: string;
  onSelect?: (id: string) => void;
  onAdd?: () => void;
}

function tabText(item: TabItem): string {
  if (item.presentation !== undefined) return item.presentation;
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
  const background = () =>
    props.variant === "header"
      ? props.theme.roles.surfaces.header
      : props.theme.roles.surfaces.panel;
  useKeyboard((event) => {
    if (!props.focused || event.eventType !== "press") return;
    const key = event.name.toLowerCase();
    if (key !== "enter" && key !== "return" && key !== "space") return;
    const id = props.focusedId ?? props.activeId;
    const item = id ? props.items.find((candidate) => candidate.id === id) : undefined;
    if (!item || item.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    props.onSelect?.(item.id);
  });
  return (
    <box
      id="ui-tabs"
      width={props.width}
      height={1}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={background()}
    >
      <For each={itemIds()}>
        {(id) => {
          const item = () => itemById(id);
          const active = () => id === props.activeId;
          const palette = () =>
            componentPalette(props.theme, {
              selected: active(),
              focused: props.focused && id === (props.focusedId ?? props.activeId),
              hovered: id === props.hoveredId,
              attention: item().attention,
              disabled: item().disabled,
            });
          return (
            <box
              id={`ui-tab:${id}`}
              height={1}
              width={itemWidth(item())}
              flexDirection="row"
              backgroundColor={palette().background}
              overflow="hidden"
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                if (item().disabled || !props.onSelect) return;
                event.preventDefault();
                event.stopPropagation();
                props.onSelect(id);
              }}
            >
              {(() => {
                const content = clipTerminal(tabText(item()), itemWidth(item()));
                const markerIndex = item().attention ? content.indexOf("!") : -1;
                const before = markerIndex >= 0 ? content.slice(0, markerIndex) : content;
                const after = markerIndex >= 0 ? content.slice(markerIndex + 1) : "";
                return (
                  <>
                    <text
                      width={terminalDisplayWidth(before)}
                      fg={palette().foreground}
                      bg={palette().background}
                      attributes={active() ? 1 : 0}
                    >
                      {before}
                    </text>
                    {markerIndex >= 0 ? (
                      <text
                        width={1}
                        fg={props.theme.roles.statusTone.warning}
                        bg={palette().background}
                        attributes={1}
                      >
                        !
                      </text>
                    ) : null}
                    <text
                      width={terminalDisplayWidth(after)}
                      fg={palette().foreground}
                      bg={palette().background}
                      attributes={active() ? 1 : 0}
                    >
                      {after}
                    </text>
                  </>
                );
              })()}
            </box>
          );
        }}
      </For>
      <For each={props.onAdd ? [props.onAdd] : []}>
        {(onAdd) => (
          <>
            <box flexGrow={props.width ? 1 : 0} />
            <Button
              theme={props.theme}
              label={props.addLabel ?? "+"}
              variant="ghost"
              size="compact"
              width={addWidth()}
              background={background()}
              onPress={onAdd}
            />
          </>
        )}
      </For>
    </box>
  );
}
