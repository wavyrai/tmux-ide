import type {
  BorderTokenRole,
  ElevationTokenRole,
  ShapeTokenRole,
  SurfaceTokenRole,
  TextTokenRole,
  TypographyTokenRole,
} from "./visual-tokens.ts";

export type VisualRecipeId =
  | "application-bar"
  | "sidebar"
  | "primary-navigation"
  | "context-actions"
  | "workspace-canvas"
  | "bottom-dock"
  | "status-strip"
  | "pane-docked"
  | "pane-floating"
  | "command-palette";

/** Renderer-free styling intent. A host maps these role references to native primitives. */
export interface VisualRecipe {
  readonly id: VisualRecipeId;
  readonly surface: SurfaceTokenRole;
  readonly text: TextTokenRole;
  readonly border: BorderTokenRole;
  readonly typography: TypographyTokenRole;
  readonly shape: ShapeTokenRole;
  readonly elevation: ElevationTokenRole | null;
}

export const VISUAL_RECIPE_REGISTRY: Readonly<Record<VisualRecipeId, VisualRecipe>> = Object.freeze(
  {
    "application-bar": {
      id: "application-bar",
      surface: "header",
      text: "bright",
      border: "subtle",
      typography: "label",
      shape: "dockedRadius",
      elevation: null,
    },
    sidebar: {
      id: "sidebar",
      surface: "panel",
      text: "secondary",
      border: "subtle",
      typography: "metadata",
      shape: "dockedRadius",
      elevation: null,
    },
    "primary-navigation": {
      id: "primary-navigation",
      surface: "header",
      text: "primary",
      border: "subtle",
      typography: "label",
      shape: "controlRadius",
      elevation: null,
    },
    "context-actions": {
      id: "context-actions",
      surface: "header",
      text: "secondary",
      border: "subtle",
      typography: "label",
      shape: "controlRadius",
      elevation: null,
    },
    "workspace-canvas": {
      id: "workspace-canvas",
      surface: "canvas",
      text: "primary",
      border: "subtle",
      typography: "workspace",
      shape: "dockedRadius",
      elevation: null,
    },
    "bottom-dock": {
      id: "bottom-dock",
      surface: "panel",
      text: "primary",
      border: "default",
      typography: "workspace",
      shape: "dockedRadius",
      elevation: null,
    },
    "status-strip": {
      id: "status-strip",
      surface: "header",
      text: "muted",
      border: "subtle",
      typography: "metadata",
      shape: "statusRadius",
      elevation: null,
    },
    "pane-docked": {
      id: "pane-docked",
      surface: "terminal",
      text: "primary",
      border: "default",
      typography: "workspace",
      shape: "dockedRadius",
      elevation: null,
    },
    "pane-floating": {
      id: "pane-floating",
      surface: "panelRaised",
      text: "primary",
      border: "default",
      typography: "workspace",
      shape: "floatingRadius",
      elevation: "floating",
    },
    "command-palette": {
      id: "command-palette",
      surface: "command",
      text: "primary",
      border: "focused",
      typography: "workspace",
      shape: "floatingRadius",
      elevation: "palette",
    },
  },
);
