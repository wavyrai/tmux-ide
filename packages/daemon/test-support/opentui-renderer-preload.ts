import type { TestRendererSetup } from "@opentui/core/testing";
import { afterEach } from "bun:test";

const REGISTRY = Symbol.for("tmux-ide.opentui-test-renderers");

type RendererGlobals = typeof globalThis & {
  [REGISTRY]?: Set<TestRendererSetup>;
};

export function openTuiTestRendererRegistry(): Set<TestRendererSetup> {
  const globals = globalThis as RendererGlobals;
  return (globals[REGISTRY] ??= new Set<TestRendererSetup>());
}

// This module is a Bun test preload, so the hook applies to every renderer
// test file. Registering it only from an imported helper scopes cleanup to the
// helper module and lets renderers from sibling files accumulate.
afterEach(() => {
  const active = openTuiTestRendererRegistry();
  for (const setup of active) setup.renderer.destroy();
  active.clear();
});
