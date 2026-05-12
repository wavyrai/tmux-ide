import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChangesView } from "./widgets/Changes";
import { CostsView } from "./widgets/Costs";
import { ExplorerView } from "./widgets/Explorer";
import { MissionControlView } from "./widgets/MissionControl";
import { PlansRailView } from "./widgets/PlansRail";
import type {
  BaseMountOptions,
  ExplorerMountHandle,
  ExplorerMountOptions,
  MountHandle,
  PlansRailMountHandle,
  PlansRailMountOptions,
} from "./types";

export type {
  BaseMountOptions,
  ExplorerMountHandle,
  ExplorerMountOptions,
  MountHandle,
  PlansRailMountHandle,
  PlansRailMountOptions,
} from "./types";

/**
 * Mount the Costs widget as a Solid DOM island into a host container.
 *
 * Usage from React:
 *   const handle = mountCosts(containerRef.current, {
 *     sessionName, apiBaseUrl, bearerToken,
 *   });
 *   handle.setOptions({ ... });   // re-target without remount
 *   handle.unmount();             // dispose Solid runtime
 */
export function mountCosts(container: HTMLElement, opts: BaseMountOptions): MountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <CostsView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Explorer widget as a Solid DOM island. Same lifecycle as
 * mountCosts but accepts ExplorerMountOptions which include an optional
 * onOpenFile(path) callback fired when the user activates a file
 * (Enter / l / right or click on a non-directory row).
 */
export function mountExplorer(
  container: HTMLElement,
  opts: ExplorerMountOptions,
): ExplorerMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <ExplorerView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Changes widget — git diff browser. Read-only patch viewer
 * with a left file rail and right unified/split patch view. Backed by
 * /api/project/:name/diff and /api/project/:name/diff/:file.
 */
export function mountChanges(container: HTMLElement, opts: BaseMountOptions): MountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <ChangesView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Mission Control widget — combines mission state, milestones,
 * agents, in-flight tasks, and recent events. Polls every 5s. Backed by
 * /api/project/:name/mission, /api/project/:name, /api/project/:name/events.
 */
export function mountMissionControl(container: HTMLElement, opts: BaseMountOptions): MountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <MissionControlView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Plans rail — left-rail navigator for the plans surface.
 * Backed by /api/project/:name/plans. Owns search / sort / collapsed-
 * group state internally; the host owns the currently-selected file
 * (push it via setOptions) and the row-activate + create callbacks.
 *
 * Polls every 5s. Visual + behavior parity with the React rail at
 * dashboard/components/plans/PlansView.tsx → PlanListNavigator.
 */
export function mountPlansRail(
  container: HTMLElement,
  opts: PlansRailMountOptions,
): PlansRailMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <PlansRailView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}
