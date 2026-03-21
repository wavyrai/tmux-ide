// Environment detection: export web components in browser, terminal components in Node/Bun
//
// This module is the single import point for widget code that needs to run
// in both terminal (@opentui) and browser (DOM) environments.
//
// Usage:
//   import { render, useKeyboard, box, text } from "../../ui/index.ts";

export * from "./web/index.ts";
