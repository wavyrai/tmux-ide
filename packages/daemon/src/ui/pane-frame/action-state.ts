import type { PaneFrameAction, PaneFrameModel } from "./presenter.js";

export type EffectivePaneFrameActionVisualState =
  | "disabled"
  | "loading"
  | "pressed"
  | "focused"
  | "attention"
  | "hovered"
  | "base";

export interface EffectivePaneFrameActionState {
  readonly active: boolean;
  readonly disabled: boolean;
  readonly attention: boolean;
  readonly focused: boolean;
  readonly hovered: boolean;
  readonly interactive: boolean;
  readonly loading: boolean;
  readonly pressed: boolean;
  readonly state: EffectivePaneFrameActionVisualState;
}

/**
 * Canonical action-state precedence shared by cell and DOM PaneFrame hosts.
 * Disabled/loading suppress transient states and only interactive actions may
 * become pointer or keyboard targets.
 */
export function resolveEffectivePaneFrameActionState(input: {
  readonly appearance: PaneFrameModel["appearance"];
  readonly action: PaneFrameAction;
  readonly attention: boolean;
  readonly hostHovered: boolean;
  readonly hostPressed: boolean;
  readonly hostFocusVisible?: boolean;
}): EffectivePaneFrameActionState {
  const global = input.appearance.action;
  const explicitDisabled = global.disabled || !input.action.available;
  const loading = !explicitDisabled && (global.loading || input.action.busy);
  const disabled =
    explicitDisabled || (!global.interactive && !global.loading && !input.action.busy);
  const interactive = global.interactive && input.action.available && !input.action.busy;
  const transient = interactive && !disabled && !loading;
  const pressed = transient && (input.hostPressed || input.action.pressed || global.pressed);
  const focused = transient && (input.hostFocusVisible === true || global.focusVisible);
  const attention = transient && (input.attention || input.action.attention === true);
  const hovered = transient && (input.hostHovered || global.hover);
  const state: EffectivePaneFrameActionVisualState = disabled
    ? "disabled"
    : loading
      ? "loading"
      : pressed
        ? "pressed"
        : focused
          ? "focused"
          : attention
            ? "attention"
            : hovered
              ? "hovered"
              : "base";
  return {
    active: state === "pressed" && input.action.pressed,
    disabled,
    attention: state === "attention",
    focused: state === "focused",
    hovered: state === "hovered",
    interactive,
    loading,
    pressed: state === "pressed",
    state,
  };
}
