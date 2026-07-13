/**
 * The web host's intrinsic contract.
 *
 * Without this, TS resolves <text> to the SVG element and rejects `fg` — the
 * universal renderer has no built-in element types. Declaring them here is what
 * lets the sidebar's JSX typecheck against the SAME props the terminal app
 * passes, so a prop the host hasn't taught itself yet is a type error at build
 * time rather than a silently-wrong pixel at runtime.
 *
 * Keep in step with applyProp() in host.ts.
 */
import type { JSX } from "solid-js";
import type { RGBA } from "./opentui-shim.ts";

type Cells = number;

interface Layout {
  flexDirection?: "row" | "column";
  flexGrow?: number;
  gap?: Cells;
  width?: Cells;
  height?: Cells;
  paddingLeft?: Cells;
  marginTop?: Cells;
  overflow?: "hidden" | "visible" | "scroll";
  position?: "absolute" | "relative";
  left?: Cells;
  top?: Cells;
  right?: Cells;
}

interface Paint {
  backgroundColor?: RGBA;
  bg?: RGBA;
  fg?: RGBA;
  /** OpenTUI bitfield; bit 0 is bold. */
  attributes?: number;
}

/** Same contract as OpenTUI's: one handler, CELL coordinates. The web host
 *  synthesizes the cells from DOM pixels (host.ts) so shared components need no
 *  web-specific props. */
interface Pointer {
  onMouse?: (e: { type: string; x: number; y: number; button?: number }) => void;
}

interface TuiElement extends Layout, Paint, Pointer {
  children?: JSX.Element;
}

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      box: TuiElement;
      text: TuiElement;
      scrollbox: TuiElement;
    }
  }
}
