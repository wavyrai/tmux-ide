/* @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { Tabs } from "../ui/tabs.tsx";

export interface TerminalWindowTab {
  index: number;
  name: string;
  active: boolean;
  sync: boolean;
  semanticWindowId: string | null;
  activePaneId: string | null;
  status?: string;
  attention?: boolean;
}

export interface TerminalWindowStripProps {
  theme: SemanticThemeSnapshot;
  tabs: readonly TerminalWindowTab[];
  hoveredIndex: number | null;
  width?: number;
  onActivate: (windowIndex: number) => void;
  onNewWindow: () => void;
}

/**
 * Retained OpenTUI window tabs with direct pointer ownership.
 *
 * The pre-0.4 strip grouped labels into shared text runs and relied on an
 * ancestor coordinate router. Label cells could be swallowed before reaching
 * that router. Each stable tab now owns its left click and stops propagation;
 * right-click and pointer motion still bubble to the application shell.
 */
export function TerminalWindowStrip(props: TerminalWindowStripProps) {
  const tabId = (tab: TerminalWindowTab) => tab.semanticWindowId ?? `window:${tab.index}`;
  const items = createMemo(() =>
    props.tabs.map((tab) => ({
      id: tabId(tab),
      label: `${tab.index}:${tab.name}`,
      badge: tab.status ? `[${tab.status}]` : undefined,
      attention: tab.attention,
    })),
  );
  const activeId = createMemo(() => {
    const active = props.tabs.find((tab) => tab.active);
    return active ? tabId(active) : null;
  });
  const hoveredId = createMemo(() => {
    if (props.hoveredIndex === null) return null;
    const hovered = props.tabs[props.hoveredIndex];
    return hovered ? tabId(hovered) : null;
  });
  return (
    <Tabs
      theme={props.theme}
      width={props.width}
      fit={props.width ? "equal" : "content"}
      items={items()}
      activeId={activeId()}
      hoveredId={hoveredId()}
      addLabel={props.width && props.width >= 72 ? "+ New window" : "+"}
      onSelect={(id) => {
        const tab = props.tabs.find((candidate) => tabId(candidate) === id);
        if (tab) props.onActivate(tab.index);
      }}
      onAdd={props.onNewWindow}
    />
  );
}
