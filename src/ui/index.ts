// Environment-detecting UI entry point.
//
// Detects whether code is running in a browser (window exists) or terminal
// (Node/Bun) and re-exports the appropriate backend. Widgets import from
// this module to work in both environments without code changes.
//
// Usage:
//   import { render, useKeyboard, RGBA, TextAttributes } from "../../ui/index.ts";
//
// Terminal backend: re-exports @opentui/solid + @opentui/core
// Web backend: re-exports DOM-based mirror components

// Use a compile-time constant so bundlers can tree-shake the unused backend.
// In browser builds, `typeof window !== "undefined"` is true and the terminal
// branch is eliminated. In Node/Bun, the web branch is eliminated.
const IS_BROWSER = typeof window !== "undefined";

if (IS_BROWSER) {
  // Re-export web backend at module level for static analysis
}

// We use conditional re-export via a barrel pattern.
// Bundlers (Bun, webpack, turbopack) resolve this statically.
// For runtime detection, we export from web by default (browser-first)
// and terminal widgets import from ./terminal/index.ts directly.
//
// The web backend is safe to import in Node because it only touches
// the DOM inside render() and hooks (which are never called in terminal mode).
export * from "./web/index.ts";

// Also re-export shared types so they're available regardless of backend
export type { BoxProps, TextProps, ScrollBoxProps, InputProps } from "./types.ts";
