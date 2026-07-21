import { createContext, type JSX, type ParentProps, useContext } from "solid-js";
import {
  WorkbenchDockPresenter,
  type WorkbenchDockHostLeaves,
  type WorkbenchDockHostProjection,
  type WorkbenchDockHostTabId,
  type WorkbenchDockHostActionId,
  type WorkbenchDockHostActivationSource,
  type WorkbenchDockHostMode,
} from "./presenter.js";
import { workbenchDockNavigationTarget } from "./navigation.js";
import "./web-host.css";

const TAB_GLYPHS: Readonly<Record<WorkbenchDockHostTabId, string>> = {
  files: "▤",
  changes: "±",
  missions: "◆",
  activity: "◌",
};

export type WebWorkbenchDockProps = ParentProps<{
  projection: WorkbenchDockHostProjection;
  onTabActivate?: (
    tabId: WorkbenchDockHostTabId,
    source: WorkbenchDockHostActivationSource,
  ) => void;
  onActionActivate?: (
    actionId: WorkbenchDockHostActionId,
    nextMode: WorkbenchDockHostMode,
    source: WorkbenchDockHostActivationSource,
  ) => void;
  renderTabIcon?: (tab: WorkbenchDockHostProjection["tabs"][number]) => JSX.Element;
  renderActionIcon?: (action: WorkbenchDockHostProjection["actions"][number]) => JSX.Element;
}>;

interface WebWorkbenchDockRenderers {
  readonly tabIcon?: WebWorkbenchDockProps["renderTabIcon"];
  readonly actionIcon?: WebWorkbenchDockProps["renderActionIcon"];
}

const WebWorkbenchDockRenderContext = createContext<WebWorkbenchDockRenderers>({});

/** Standard Solid DOM host for the shared production dock presenter. */
export function WebWorkbenchDock(props: WebWorkbenchDockProps) {
  return (
    <WebWorkbenchDockRenderContext.Provider
      value={{ tabIcon: props.renderTabIcon, actionIcon: props.renderActionIcon }}
    >
      <WorkbenchDockPresenter
        host={WEB_WORKBENCH_DOCK_HOST}
        projection={props.projection}
        body={props.children}
        onTabActivate={props.onTabActivate}
        onActionActivate={props.onActionActivate}
      />
    </WebWorkbenchDockRenderContext.Provider>
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

      const currentId = current.dataset.tabId as WorkbenchDockHostTabId | undefined;
      if (!currentId) return;
      const targetId = workbenchDockNavigationTarget(props.tabs, currentId, {
        name: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      });
      const next = targetId
        ? tabs.find((candidate) => candidate.dataset.tabId === targetId)
        : undefined;
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.click();
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
    const renderers = useContext(WebWorkbenchDockRenderContext);
    const accessibleLabel = () =>
      [props.tab.title, props.tab.attention ? "needs attention" : null, props.tab.disabledReason]
        .filter(Boolean)
        .join(", ");
    return (
      <button
        class="workbench-dock__tab"
        id={`workbench-dock-tab-${props.tab.id}`}
        data-tab-id={props.tab.id}
        type="button"
        role="tab"
        aria-label={accessibleLabel()}
        aria-controls={`workbench-dock-panel-${props.tab.id}`}
        aria-selected={props.tab.selected}
        aria-disabled={props.tab.disabled}
        disabled={props.tab.disabled}
        tabIndex={props.tabStop ? 0 : -1}
        title={`${props.tab.title}${props.tab.shortcut ? ` (${props.tab.shortcut})` : ""}${props.tab.disabledReason ? ` — ${props.tab.disabledReason}` : ""}`}
        data-attention={props.tab.attention ? "true" : "false"}
        data-focused={props.tab.focused ? "true" : "false"}
        data-hovered={props.tab.hovered ? "true" : "false"}
        onClick={(event) => props.onActivate?.(event.detail === 0 ? "keyboard" : "mouse")}
      >
        <span class="workbench-dock__shortcut" aria-hidden="true">
          {props.tab.shortcut}
        </span>
        <span class="workbench-dock__glyph" aria-hidden="true">
          {renderers.tabIcon?.(props.tab) ?? TAB_GLYPHS[props.tab.id]}
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
    const renderers = useContext(WebWorkbenchDockRenderContext);
    const collapse = () => props.action.id === "toggle-collapse";
    return (
      <button
        class="workbench-dock__action"
        type="button"
        aria-label={props.action.description}
        aria-controls={collapse() ? `workbench-dock-panel-${props.activeTabId}` : undefined}
        aria-expanded={collapse() ? props.action.active : undefined}
        aria-pressed={collapse() ? undefined : props.action.active}
        data-action={props.action.id}
        title={props.action.description}
        onClick={(event) => props.onActivate?.(event.detail === 0 ? "keyboard" : "mouse")}
      >
        {renderers.actionIcon?.(props.action) ?? props.action.label.trim()}
      </button>
    );
  },
  Body(props) {
    return (
      <section
        class="workbench-dock__body"
        id={`workbench-dock-panel-${props.tabId}`}
        role="tabpanel"
        aria-labelledby={`workbench-dock-tab-${props.tabId}`}
        aria-hidden={!props.visible}
        hidden={!props.visible}
        tabIndex={props.visible ? 0 : -1}
        data-focused={props.focused ? "true" : "false"}
      >
        {props.children}
      </section>
    );
  },
};
