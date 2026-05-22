/**
 * Off-screen xterm host (G20-P1).
 *
 * Singleton hidden `<div data-terminal-host>` mounted at
 * `position: fixed; left: -10000px;`. Every Terminal instance lives in
 * this host when not visible — preserving scrollback + cursor state
 * across mount/unmount cycles because xterm itself never disposes.
 *
 * This is the load-bearing pattern for the tab strip in P3: switching
 * tabs is a DOM `appendChild` + Canvas refresh, not a Terminal
 * recreate. Don't move terminals back to the page-level DOM tree on
 * unmount — use `ensureXtermHost()` as the parking lot.
 */

let hostElement: HTMLDivElement | null = null;

export function ensureXtermHost(): HTMLDivElement {
  if (hostElement) return hostElement;
  const el = document.createElement("div");
  el.setAttribute("data-terminal-host", "true");
  Object.assign(el.style, {
    position: "fixed",
    left: "-10000px",
    top: "0px",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    pointerEvents: "none",
    visibility: "hidden",
    zIndex: "-1",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  hostElement = el;
  return el;
}

/** Test/HMR escape hatch — disposes the host so a fresh
 *  `ensureXtermHost()` rebuilds it. Never called from production. */
export function _resetXtermHostForTests(): void {
  hostElement?.remove();
  hostElement = null;
}
