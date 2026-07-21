import { For, Show, type Component, type JSX, type ParentProps } from "solid-js";
import type { WorkbenchDockNavigationTabId } from "./navigation.js";

export type WorkbenchDockHostTabId = WorkbenchDockNavigationTabId;
export type WorkbenchDockHostActionId = "toggle-collapse" | "toggle-maximize";
export type WorkbenchDockHostMode = "collapsed" | "open" | "maximized";
export type WorkbenchDockHostVariant = "compact" | "standard" | "wide";

export interface WorkbenchDockHostRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkbenchDockHostTab {
  readonly id: WorkbenchDockHostTabId;
  readonly title: string;
  readonly label: string;
  readonly shortcut: string;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly hovered: boolean;
  readonly attention: boolean;
  readonly disabled: boolean;
  readonly x: number;
  readonly width: number;
}

export interface WorkbenchDockHostAction {
  readonly id: WorkbenchDockHostActionId;
  readonly label: string;
  readonly description: string;
  readonly nextMode: WorkbenchDockHostMode;
  readonly active: boolean;
  readonly x: number;
  readonly width: number;
}

/**
 * The renderer-neutral subset of the canonical WorkbenchShell projection.
 * WorkbenchShellProjection satisfies this structurally; the presenter neither
 * derives geometry nor owns state.
 */
export interface WorkbenchDockHostProjection {
  readonly variant: WorkbenchDockHostVariant;
  readonly dockMode: WorkbenchDockHostMode;
  readonly focusZone: "canvas" | "dock-tabs" | "dock-body";
  readonly activeDockTab: WorkbenchDockHostTabId;
  readonly dock: WorkbenchDockHostRect;
  readonly dockTabs: WorkbenchDockHostRect;
  readonly dockBody: WorkbenchDockHostRect;
  readonly dockBodyRail: WorkbenchDockHostRect;
  readonly dockBodyContent: WorkbenchDockHostRect;
  readonly tabs: readonly WorkbenchDockHostTab[];
  readonly actions: readonly WorkbenchDockHostAction[];
}

export type WorkbenchDockRootLeafProps = ParentProps<{
  projection: WorkbenchDockHostProjection;
}>;

export type WorkbenchDockTabBarLeafProps = ParentProps<{
  projection: WorkbenchDockHostProjection;
}>;

export type WorkbenchDockTabListLeafProps = ParentProps<{
  activeTabId: WorkbenchDockHostTabId;
  tabs: readonly WorkbenchDockHostTab[];
  focused: boolean;
}>;

export interface WorkbenchDockTabLeafProps {
  tab: WorkbenchDockHostTab;
  onActivate?: () => void;
}

export interface WorkbenchDockActionListLeafProps {
  children?: JSX.Element;
}

export interface WorkbenchDockActionLeafProps {
  action: WorkbenchDockHostAction;
  activeTabId: WorkbenchDockHostTabId;
  onActivate?: () => void;
}

export type WorkbenchDockBodyLeafProps = ParentProps<{
  projection: WorkbenchDockHostProjection;
  tabId: WorkbenchDockHostTabId;
  active: boolean;
  visible: boolean;
  focused: boolean;
}>;

/** Every JSX leaf is injected so this module has no terminal or DOM intrinsic. */
export interface WorkbenchDockHostLeaves {
  Root: Component<WorkbenchDockRootLeafProps>;
  TabBar: Component<WorkbenchDockTabBarLeafProps>;
  TabList: Component<WorkbenchDockTabListLeafProps>;
  Tab: Component<WorkbenchDockTabLeafProps>;
  ActionList: Component<WorkbenchDockActionListLeafProps>;
  Action: Component<WorkbenchDockActionLeafProps>;
  Body: Component<WorkbenchDockBodyLeafProps>;
}

export interface WorkbenchDockPresenterProps {
  projection: WorkbenchDockHostProjection;
  host: WorkbenchDockHostLeaves;
  body?: JSX.Element;
  onTabActivate?: (tabId: WorkbenchDockHostTabId) => void;
  onActionActivate?: (actionId: WorkbenchDockHostActionId, nextMode: WorkbenchDockHostMode) => void;
}

/**
 * Shared Solid control flow for the current production bottom dock.
 *
 * The canonical workbench projection and root controller remain the only state
 * and action owners. This presenter merely sends that projection through
 * injected, capitalized host leaves.
 */
export function WorkbenchDockPresenter(props: WorkbenchDockPresenterProps) {
  const Root = props.host.Root;
  const TabBar = props.host.TabBar;
  const TabList = props.host.TabList;
  const Tab = props.host.Tab;
  const ActionList = props.host.ActionList;
  const Action = props.host.Action;
  const Body = props.host.Body;

  return (
    <Root projection={props.projection}>
      <TabBar projection={props.projection}>
        <TabList
          activeTabId={props.projection.activeDockTab}
          tabs={props.projection.tabs}
          focused={props.projection.focusZone === "dock-tabs"}
        >
          <For each={props.projection.tabs}>
            {(tab) => (
              <Tab
                tab={tab}
                onActivate={tab.disabled ? undefined : () => props.onTabActivate?.(tab.id)}
              />
            )}
          </For>
        </TabList>
        <ActionList>
          <For each={props.projection.actions}>
            {(action) => (
              <Action
                action={action}
                activeTabId={props.projection.activeDockTab}
                onActivate={() => props.onActionActivate?.(action.id, action.nextMode)}
              />
            )}
          </For>
        </ActionList>
      </TabBar>

      <For each={props.projection.tabs}>
        {(tab) => (
          <Body
            projection={props.projection}
            tabId={tab.id}
            active={tab.selected}
            visible={tab.selected && props.projection.dockBody.height > 0}
            focused={tab.selected && props.projection.focusZone === "dock-body"}
          >
            <Show when={tab.selected}>{props.body}</Show>
          </Body>
        )}
      </For>
    </Root>
  );
}
