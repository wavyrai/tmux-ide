import {
  createContext,
  createMemo,
  createSignal,
  type JSX,
  type ParentProps,
  useContext,
} from "solid-js";
import type { PaneRoleId, SemanticIconId } from "@tmux-ide/contracts";
import { resolveEffectivePaneFrameActionState } from "./action-state.js";
import {
  PaneFramePresenter,
  type PaneFrameAction,
  type PaneFrameActionIntent,
  type PaneFrameActivationSource,
  type PaneFrameGripIntent,
  type PaneFrameHostLeaves,
  type PaneFrameModel,
  type PaneFramePane,
  type PaneFrameStatusItem,
} from "./presenter.js";
import "./web-host.css";

const PANE_ROLE_ICONS: Readonly<Record<PaneRoleId, SemanticIconId>> = {
  home: "home",
  terminal: "terminals",
  files: "files",
  changes: "changes",
  missions: "missions",
  activity: "activity",
  preview: "preview",
  native: "native",
};

export interface WebPaneFrameProps extends ParentProps {
  readonly model: PaneFrameModel;
  readonly onActionActivate?: (
    intent: PaneFrameActionIntent,
    source: PaneFrameActivationSource,
  ) => void;
  readonly onGripActivate?: (
    intent: PaneFrameGripIntent,
    source: PaneFrameActivationSource,
  ) => void;
  readonly renderPaneIcon?: (pane: PaneFramePane, icon: SemanticIconId) => JSX.Element;
  readonly renderActionIcon?: (action: PaneFrameAction) => JSX.Element;
  readonly renderGripIcon?: (icon: "move") => JSX.Element;
}

interface WebPaneFrameContextValue {
  readonly renderPaneIcon?: WebPaneFrameProps["renderPaneIcon"];
  readonly renderActionIcon?: WebPaneFrameProps["renderActionIcon"];
  readonly renderGripIcon?: WebPaneFrameProps["renderGripIcon"];
}

const WebPaneFrameContext = createContext<WebPaneFrameContextValue>({});

function statusItemLabel(item: PaneFrameStatusItem): string {
  return item.kind === "status" ? item.status.label : item.chip.label;
}

function statusItemDescription(item: PaneFrameStatusItem): string | undefined {
  return item.kind === "status" ? item.status.description : item.chip.description;
}

function statusItemTone(item: PaneFrameStatusItem): string {
  return item.kind === "status" ? item.status.tone : (item.chip.tone ?? "neutral");
}

function statusItemBusy(item: PaneFrameStatusItem): boolean {
  return item.kind === "status" && item.status.busy;
}

/** Browser/Electron host for the canonical Solid PaneFrame presenter. */
export function WebPaneFrame(props: WebPaneFrameProps) {
  return (
    <WebPaneFrameContext.Provider
      value={{
        renderPaneIcon: props.renderPaneIcon,
        renderActionIcon: props.renderActionIcon,
        renderGripIcon: props.renderGripIcon,
      }}
    >
      <PaneFramePresenter
        model={props.model}
        host={WEB_PANE_FRAME_HOST}
        body={props.children}
        onActionActivate={props.onActionActivate}
        onGripActivate={props.onGripActivate}
      />
    </WebPaneFrameContext.Provider>
  );
}

export const WEB_PANE_FRAME_HOST: PaneFrameHostLeaves = {
  Root(props) {
    return (
      <section
        class="web-pane-frame"
        aria-label={props.appearance.accessibility.description}
        aria-busy={props.appearance.accessibility.busy}
        aria-disabled={props.appearance.accessibility.disabled}
        data-pane-id={props.pane.id}
        data-pane-role={props.pane.kind}
        data-structure={props.appearance.structure}
        data-border-role={props.appearance.border.role}
        data-border-strength={props.appearance.border.strength}
        data-focused={props.appearance.accessibility.focused}
        data-terminal-input-owner={props.appearance.accessibility.terminalInputOwner}
        data-layout-selected={props.appearance.accessibility.layoutSelected}
        data-attention={props.appearance.accessibility.hasAttention}
        data-busy={props.appearance.accessibility.busy}
        data-disabled={props.appearance.accessibility.disabled}
        data-window-active={props.appearance.header.windowActive}
      >
        {props.children}
      </section>
    );
  },
  Header(props) {
    return (
      <header
        class="web-pane-frame__header"
        data-surface={props.appearance.header.surface}
        data-agent-activity={props.appearance.header.agentActivity}
        data-attention={props.appearance.header.attention}
      >
        {props.children}
      </header>
    );
  },
  Grip(props) {
    const renderers = useContext(WebPaneFrameContext);
    const disabled = () =>
      props.onActivate === undefined || props.appearance.accessibility.disabled;
    return (
      <button
        class="web-pane-frame__grip"
        type="button"
        aria-label={`Move ${props.pane.kind} pane`}
        aria-disabled={disabled()}
        disabled={disabled()}
        title={disabled() ? "Pane movement unavailable" : "Move pane"}
        onClick={(event) => props.onActivate?.(event.detail === 0 ? "keyboard" : "mouse")}
      >
        {renderers.renderGripIcon?.("move") ?? <span aria-hidden="true">⠿</span>}
      </button>
    );
  },
  Title(props) {
    const renderers = useContext(WebPaneFrameContext);
    return (
      <div class="web-pane-frame__identity">
        <span class="web-pane-frame__role-icon" aria-hidden="true">
          {renderers.renderPaneIcon?.(props.pane, PANE_ROLE_ICONS[props.pane.kind]) ?? "▣"}
        </span>
        <span class="web-pane-frame__title-group">
          <strong class="web-pane-frame__title" title={props.title}>
            {props.title}
          </strong>
          {props.subtitle ? (
            <small class="web-pane-frame__subtitle" title={props.subtitle}>
              {props.subtitle}
            </small>
          ) : null}
        </span>
      </div>
    );
  },
  Status(props) {
    return (
      <span
        class="web-pane-frame__status"
        role={statusItemBusy(props.item) ? "status" : undefined}
        aria-label={statusItemDescription(props.item) ?? statusItemLabel(props.item)}
        title={statusItemDescription(props.item) ?? statusItemLabel(props.item)}
        data-item-kind={props.item.kind}
        data-item-id={props.item.id}
        data-chip-kind={props.item.kind === "chip" ? props.item.chip.kind : "domain"}
        data-tone={statusItemTone(props.item)}
        data-busy={statusItemBusy(props.item)}
      >
        <i aria-hidden="true" />
        <span>{statusItemLabel(props.item)}</span>
      </span>
    );
  },
  ActionList(props) {
    return (
      <div class="web-pane-frame__actions" role="toolbar" aria-label="Pane controls">
        {props.children}
      </div>
    );
  },
  Action(props) {
    const renderers = useContext(WebPaneFrameContext);
    const [hovered, setHovered] = createSignal(false);
    const [pressed, setPressed] = createSignal(false);
    const [focusVisible, setFocusVisible] = createSignal(false);
    const effective = createMemo(() =>
      resolveEffectivePaneFrameActionState({
        appearance: props.appearance,
        action: props.action,
        attention: props.action.attention === true,
        hostHovered: hovered(),
        hostPressed: pressed(),
        hostFocusVisible: focusVisible(),
      }),
    );
    const disabled = () =>
      props.onActivate === undefined ||
      !props.interactive ||
      effective().disabled ||
      effective().loading;
    const visualState = () =>
      props.onActivate === undefined && !effective().loading ? "disabled" : effective().state;
    const description = () =>
      props.action.disabledReason ?? props.action.description ?? props.action.label;
    const isToggle = () => props.action.id.endsWith("-toggle");
    return (
      <button
        class="web-pane-frame__action"
        type="button"
        aria-label={description()}
        aria-disabled={disabled()}
        aria-busy={effective().loading}
        aria-pressed={isToggle() ? props.action.pressed : undefined}
        disabled={disabled()}
        title={description()}
        data-action-id={props.action.id}
        data-command-id={props.action.commandId}
        data-state={visualState()}
        data-active={effective().active}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setPressed(false);
        }}
        onMouseDown={() => {
          setFocusVisible(false);
          setPressed(true);
        }}
        onMouseUp={() => setPressed(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            setFocusVisible(true);
            setPressed(true);
          }
        }}
        onKeyUp={() => setPressed(false)}
        onFocus={(event) => setFocusVisible(event.currentTarget.matches(":focus-visible"))}
        onBlur={() => {
          setFocusVisible(false);
          setPressed(false);
        }}
        onClick={(event) => props.onActivate?.(event.detail === 0 ? "keyboard" : "mouse")}
      >
        {renderers.renderActionIcon?.(props.action) ?? (
          <span class="web-pane-frame__action-fallback" aria-hidden="true">
            {props.action.icon.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span class="web-pane-frame__action-label">{props.action.label}</span>
      </button>
    );
  },
  Body(props) {
    return (
      <div
        class="web-pane-frame__body"
        id={`pane-frame-body-${props.pane.id}`}
        data-pane-body={props.pane.id}
        data-body-sentinel="stable"
        aria-label={`${props.pane.kind} pane content`}
      >
        {props.children}
      </div>
    );
  },
};
