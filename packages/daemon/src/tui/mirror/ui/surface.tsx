/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { splitProps } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { componentPalette, type ComponentInteractionState, type ComponentTone } from "./state.ts";

export type SurfaceVariant = "canvas" | "panel" | "raised" | "header";

type NativeBoxProps = JSX.IntrinsicElements["box"];
type StateProp = keyof ComponentInteractionState;

export type SurfaceProps = Omit<NativeBoxProps, "backgroundColor" | "borderColor" | StateProp> &
  ComponentInteractionState & {
    theme: SemanticThemeSnapshot;
    variant?: SurfaceVariant;
    tone?: ComponentTone;
  };

/** Semantic app-owned surface. Terminal framebuffer content must never be mounted through it. */
export function Surface(props: SurfaceProps) {
  const [local, native] = splitProps(props, [
    "theme",
    "variant",
    "tone",
    "selected",
    "focused",
    "hovered",
    "pressed",
    "disabled",
    "attention",
    "loading",
    "empty",
    "status",
  ]);
  const palette = () => componentPalette(local.theme, local, local.tone);
  const hasState = () =>
    Boolean(
      local.selected ||
      local.focused ||
      local.hovered ||
      local.pressed ||
      local.disabled ||
      local.attention ||
      local.loading ||
      local.empty ||
      local.status ||
      local.tone === "warning" ||
      local.tone === "destructive",
    );
  const baseSurface = () => {
    switch (local.variant ?? "panel") {
      case "canvas":
        return local.theme.roles.surfaces.canvas;
      case "raised":
        return local.theme.roles.surfaces.panelRaised;
      case "header":
        return local.theme.roles.surfaces.header;
      case "panel":
      default:
        return local.theme.roles.surfaces.panel;
    }
  };
  return (
    <box
      {...native}
      backgroundColor={hasState() ? palette().background : baseSurface()}
      borderColor={native.border ? palette().border : undefined}
    />
  );
}
