// Web mirror components — lowercase exports match @opentui JSX element names
export { Box as box } from "./components/Box.tsx";
export { Text as text } from "./components/Text.tsx";
export { ScrollBox as scrollbox } from "./components/ScrollBox.tsx";
export { Input as input } from "./components/Input.tsx";

// Render and hooks
export { render } from "./render.ts";
export { useKeyboard, useTerminalDimensions } from "./hooks.ts";

// Re-export Solid.js primitives
export {
  Show,
  For,
  Switch,
  Match,
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  batch,
} from "solid-js";

// Re-export shared types
export { RGBA, TextAttributes } from "../types.ts";
export type { BoxProps, TextProps, ScrollBoxProps, InputProps } from "../types.ts";
