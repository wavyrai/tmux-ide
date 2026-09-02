import type { createCliRenderer } from "@opentui/core";
import type { SemanticThemeSnapshot } from "../theme.ts";

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

/** Apply one complete semantic appearance at the renderer boundary.
 *
 * Background mutation deliberately precedes the full-frame damage request so
 * OpenTUI can never repaint new chrome over a stale canvas. The generation is
 * supplied by the appearance owner, keeping unrelated Solid effects from
 * producing extra renderer transactions.
 */
export function applyApplicationAppearanceToRenderer(
  renderer: Renderer,
  theme: SemanticThemeSnapshot,
  generation: number,
  paintedGeneration: number | null,
): number {
  renderer.setBackgroundColor(theme.roles.surfaces.canvas);
  if (paintedGeneration !== null && generation !== paintedGeneration)
    requestApplicationThemeRepaint(renderer);
  return generation;
}
