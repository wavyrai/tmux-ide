import { Index, Show, type Component, type JSX, type ParentProps } from "solid-js";
import type { WorkbenchDockNavigationTabId } from "./navigation.js";

export type WorkbenchDockHostTabId = WorkbenchDockNavigationTabId;
export type WorkbenchDockHostActionId = "toggle-collapse" | "toggle-maximize";
export type WorkbenchDockHostMode = "collapsed" | "open" | "maximized";
export type WorkbenchDockHostVariant = "compact" | "standard" | "wide";

export const WORKBENCH_DOCK_HOST_TAB_ORDER = Object.freeze([
  "files",
  "changes",
  "missions",
  "activity",
] as const satisfies readonly WorkbenchDockHostTabId[]);

export const WORKBENCH_DOCK_HOST_ACTION_ORDER = Object.freeze([
  "toggle-collapse",
  "toggle-maximize",
] as const satisfies readonly WorkbenchDockHostActionId[]);

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
  /** Host-visible explanation for an unavailable canonical surface. */
  readonly disabledReason?: string | null;
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

/** Positional host leaves are safe only while the canonical fixed order holds. */
export function assertWorkbenchDockHostOrder(projection: WorkbenchDockHostProjection): void {
  const tabOrder = projection.tabs.map(({ id }) => id);
  const actionOrder = projection.actions.map(({ id }) => id);
  if (
    tabOrder.length !== WORKBENCH_DOCK_HOST_TAB_ORDER.length ||
    tabOrder.some((id, index) => id !== WORKBENCH_DOCK_HOST_TAB_ORDER[index])
  ) {
    throw new Error(`workbench dock tab order changed: ${tabOrder.join(",")}`);
  }
  if (
    actionOrder.length !== WORKBENCH_DOCK_HOST_ACTION_ORDER.length ||
    actionOrder.some((id, index) => id !== WORKBENCH_DOCK_HOST_ACTION_ORDER[index])
  ) {
    throw new Error(`workbench dock action order changed: ${actionOrder.join(",")}`);
  }
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
  const projection = (): WorkbenchDockHostProjection => {
    assertWorkbenchDockHostOrder(props.projection);
    return props.projection;
  };

  return (
    <Root projection={projection()}>
      <TabBar projection={projection()}>
        <TabList
          activeTabId={projection().activeDockTab}
          tabs={projection().tabs}
          focused={projection().focusZone === "dock-tabs"}
        >
          {/*
           * Contract projections are immutable and therefore refresh with new
           * object identities. Reference-keyed For remounted focused DOM tabs
           * (and produced OpenTUI anchor churn) on every semantic command.
           * Index preserves the host leaf at each asserted canonical slot.
           */}
          <Index each={projection().tabs}>
            {(tab) => (
              <Tab
                tab={tab()}
                onActivate={tab().disabled ? undefined : () => props.onTabActivate?.(tab().id)}
              />
            )}
          </Index>
        </TabList>
        <ActionList>
          <Index each={projection().actions}>
            {(action) => (
              <Action
                action={action()}
                activeTabId={projection().activeDockTab}
                onActivate={() => props.onActionActivate?.(action().id, action().nextMode)}
              />
            )}
          </Index>
        </ActionList>
      </TabBar>

      <Index each={projection().tabs}>
        {(tab) => (
          <Body
            projection={projection()}
            tabId={tab().id}
            active={tab().selected}
            visible={tab().selected && projection().dockBody.height > 0}
            focused={tab().selected && projection().focusZone === "dock-body"}
          >
            <Show when={tab().selected}>{props.body}</Show>
          </Body>
        )}
      </Index>
    </Root>
  );
}
