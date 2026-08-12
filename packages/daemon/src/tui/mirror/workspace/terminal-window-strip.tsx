/* @jsxImportSource @opentui/solid */
import { For } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";

export interface TerminalWindowTab {
  index: number;
  name: string;
  active: boolean;
  sync: boolean;
  semanticWindowId: string | null;
  activePaneId: string | null;
}

export interface TerminalWindowStripProps {
  theme: SemanticThemeSnapshot;
  tabs: readonly TerminalWindowTab[];
  hoveredIndex: number | null;
  onActivate: (windowIndex: number) => void;
  onNewWindow: () => void;
}

const ADD_LABEL = " + ";

/**
 * Retained OpenTUI window tabs with direct pointer ownership.
 *
 * The pre-0.4 strip grouped labels into shared text runs and relied on an
 * ancestor coordinate router. Label cells could be swallowed before reaching
 * that router. Each stable tab now owns its left click and stops propagation;
 * right-click and pointer motion still bubble to the application shell.
 */
export function TerminalWindowStrip(props: TerminalWindowStripProps) {
  const label = (tab: TerminalWindowTab) => ` ${tab.index}:${tab.name} `;
  return (
    <box paddingLeft={1} flexDirection="row" gap={1} height={1}>
      <For each={props.tabs}>
        {(tab, index) => (
          <box
            height={1}
            width={label(tab).length}
            backgroundColor={
              tab.active
                ? props.theme.roles.selection.selection
                : props.hoveredIndex === index()
                  ? props.theme.colors.buttonHover
                  : props.theme.roles.surfaces.header
            }
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              props.onActivate(tab.index);
            }}
          >
            <text
              fg={
                tab.active
                  ? props.theme.roles.selection.selectionText
                  : props.theme.roles.text.secondary
              }
            >
              {label(tab)}
            </text>
          </box>
        )}
      </For>
      <box
        height={1}
        width={ADD_LABEL.length}
        backgroundColor={
          props.hoveredIndex === props.tabs.length
            ? props.theme.colors.buttonHover
            : props.theme.roles.surfaces.header
        }
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          props.onNewWindow();
        }}
      >
        <text fg={props.theme.roles.text.primary} attributes={1}>
          {ADD_LABEL}
        </text>
      </box>
    </box>
  );
}
