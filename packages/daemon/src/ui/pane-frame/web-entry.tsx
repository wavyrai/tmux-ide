import { render } from "solid-js/web";
import { WebPaneFrame, type WebPaneFrameProps } from "./web-host.js";

/** Mount a browser/Electron PaneFrame and return Solid's disposer. */
export function mountWebPaneFrame(element: HTMLElement, props: WebPaneFrameProps): () => void {
  return render(() => <WebPaneFrame {...props} />, element);
}

export { WebPaneFrame } from "./web-host.js";
export type { WebPaneFrameProps } from "./web-host.js";
export {
  resolveEffectivePaneFrameActionState,
  type EffectivePaneFrameActionState,
  type EffectivePaneFrameActionVisualState,
} from "./action-state.js";
export type {
  PaneFrameAction,
  PaneFrameActionIntent,
  PaneFrameActivationSource,
  PaneFrameGripIntent,
  PaneFrameModel,
} from "./presenter.js";
