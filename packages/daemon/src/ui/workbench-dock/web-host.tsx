import { type JSX, type ParentProps } from "solid-js";
import {
  WorkbenchDockPresenter,
  type WorkbenchDockHostLeaves,
  type WorkbenchDockHostProjection,
  type WorkbenchDockHostTabId,
  type WorkbenchDockHostActionId,
  type WorkbenchDockHostMode,
} from "./presenter.tsx";
import "./web-host.css";

const TAB_GLYPHS: Readonly<Record<WorkbenchDockHostTabId, string>> = {
  files: "▤",
  changes: "±",
  missions: "◆",
  activity: "◌",
};

export type WebWorkbenchDockProps = ParentProps<{
  projection: WorkbenchDockHostProjection;
  onTabActivate?: (tabId: WorkbenchDockHostTabId) => void;
  onActionActivate?: (actionId: WorkbenchDockHostActionId, nextMode: WorkbenchDockHostMode) => void;
}>;

/** Standard Solid DOM host for the shared production dock presenter. */
export function WebWorkbenchDock(props: WebWorkbenchDockProps) {
  return (
    <WorkbenchDockPresenter
      host={WEB_WORKBENCH_DOCK_HOST}
      projection={props.projection}
      body={props.children}
      onTabActivate={props.onTabActivate}
      onActionActivate={props.onActionActivate}
    />
  );
}

export const WEB_WORKBENCH_DOCK_HOST: WorkbenchDockHostLeaves = {
  Root(props) {
    return (
      <section
        class="workbench-dock"
        aria-label="Workspace tools"
        data-mode={props.projection.dockMode}
        data-variant={props.projection.variant}
      >
        {props.children}
      </section>
    );
  },
  TabBar(props) {
    return <header class="workbench-dock__bar">{props.children}</header>;
  },
  TabList(props) {
    const moveFocus: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
      const tabs = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
      );
      const current = event.target instanceof HTMLButtonElement ? event.target : null;
      if (!current || tabs.length === 0) return;

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        current.click();
        return;
      }

      const currentIndex = tabs.indexOf(current);
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
      if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      tabs[nextIndex]?.focus();
    };

    return (
      <div
        class="workbench-dock__tabs"
        role="tablist"
        aria-label="Workspace surfaces"
        aria-orientation="horizontal"
        data-focused={props.focused ? "true" : "false"}
        onKeyDown={moveFocus}
      >
        {props.children}
      </div>
    );
  },
  Tab(props) {
    const accessibleLabel = () =>
      props.tab.attention ? `${props.tab.title}, needs attention` : props.tab.title;
    return (
      <button
        class="workbench-dock__tab"
        id={`workbench-dock-tab-${props.tab.id}`}
        type="button"
        role="tab"
        aria-label={accessibleLabel()}
        aria-controls={`workbench-dock-panel-${props.tab.id}`}
        aria-selected={props.tab.selected}
        aria-disabled={props.tab.disabled}
        disabled={props.tab.disabled}
        tabIndex={props.tab.selected && !props.tab.disabled ? 0 : -1}
        title={`${props.tab.title}${props.tab.shortcut ? ` (${props.tab.shortcut})` : ""}`}
        data-attention={props.tab.attention ? "true" : "false"}
        data-focused={props.tab.focused ? "true" : "false"}
        data-hovered={props.tab.hovered ? "true" : "false"}
        onClick={() => props.onActivate?.()}
      >
        <span class="workbench-dock__shortcut" aria-hidden="true">
          {props.tab.shortcut}
        </span>
        <span class="workbench-dock__glyph" aria-hidden="true">
          {TAB_GLYPHS[props.tab.id]}
        </span>
        <span class="workbench-dock__title">{props.tab.title}</span>
        <span class="workbench-dock__attention" aria-hidden="true">
          {props.tab.attention ? "●" : ""}
        </span>
      </button>
    );
  },
  ActionList(props) {
    return (
      <div class="workbench-dock__actions" aria-label="Dock controls">
        {props.children}
      </div>
    );
  },
  Action(props) {
    return (
      <button
        class="workbench-dock__action"
        type="button"
        aria-label={props.action.description}
        aria-pressed={props.action.active}
        data-action={props.action.id}
        title={props.action.description}
        onClick={() => props.onActivate?.()}
      >
        {props.action.label.trim()}
      </button>
    );
  },
  Body(props) {
    return (
      <section
        class="workbench-dock__body"
        id={`workbench-dock-panel-${props.activeTabId}`}
        role="tabpanel"
        aria-labelledby={`workbench-dock-tab-${props.activeTabId}`}
        tabIndex={0}
        data-focused={props.focused ? "true" : "false"}
      >
        {props.children}
      </section>
    );
  },
};
