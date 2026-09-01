import type { createCliRenderer } from "@opentui/core";

type Renderer = Awaited<ReturnType<typeof createCliRenderer>>;

/**
 * OpenTUI 0.5 keeps a private full-frame damage flag. A semantic theme switch
 * changes backgrounds without necessarily changing glyphs, so its ordinary
 * incremental terminal diff can leave the old background behind even though
 * the in-memory framebuffer is already correct. Keep the compatibility shim
 * here, at the renderer boundary, instead of leaking it into UI components.
 *
 * The fallback uses the public suspend/resume contract. It is only used if a
 * future OpenTUI release removes the current flag before exposing an equivalent
 * public full-repaint method.
 */
export function requestApplicationThemeRepaint(renderer: Renderer): void {
  const internals = renderer as unknown as { forceFullRepaintRequested?: boolean };
  if ("forceFullRepaintRequested" in internals) {
    internals.forceFullRepaintRequested = true;
    renderer.requestRender();
    return;
  }
  renderer.suspend();
  renderer.resume();
}
