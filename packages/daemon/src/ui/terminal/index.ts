// Terminal backend — re-exports @opentui/solid and @opentui/core for terminal rendering.
// Widgets importing from src/ui/ will get these exports when running in Node/Bun.

// Render and hooks
export { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";

// Core primitives and types
export { RGBA, TextAttributes } from "@opentui/core";
export type { ScrollBoxRenderable, InputRenderable } from "@opentui/core";
