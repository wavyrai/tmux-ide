import { render } from "solid-js/web";
import { WebWorkbenchDock, type WebWorkbenchDockProps } from "./web-host.js";

/** Mount the dock in a browser/Electron renderer and return Solid's disposer. */
export function mountWebWorkbenchDock(
  element: HTMLElement,
  props: WebWorkbenchDockProps,
): () => void {
  return render(() => <WebWorkbenchDock {...props} />, element);
}

export { WebWorkbenchDock } from "./web-host.js";
export type { WebWorkbenchDockProps } from "./web-host.js";
export type {
  WorkbenchDockHostActionId,
  WorkbenchDockHostMode,
  WorkbenchDockHostProjection,
  WorkbenchDockHostTabId,
} from "./presenter.js";
