import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";

import {
  createApplicationHomeAgentObserver,
  type ApplicationHomeAgentObserver,
} from "./application-home-agent-observer.ts";
import { createHomeAgentSelectionOwner } from "./application-home-agent-selection.ts";
import { createApplicationHomeAgentNavigator } from "./application-home-agent-navigation.ts";
import {
  applicationGenerationNavigationKey,
  createApplicationAgentNavigator,
  type createApplicationGenerationStarter,
} from "./application-generation-starter.ts";
import type { ApplicationHomeCatalogSnapshot } from "./application-home-catalog.ts";
import type { ApplicationHomeSurfaceProps } from "./application-shell-home.tsx";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import type { ApplicationShellBinding } from "./application-shell-binding.ts";
import type { createApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import { createApplicationPaletteCommandOwner } from "./application-palette-command-owner.ts";
import { createApplicationPaneRenameOwner } from "./application-pane-rename-owner.ts";
import {
  applicationPaletteCommands,
  applicationPaletteCommandSource,
} from "./application-palette-input.ts";

export type ApplicationHomeAgentPresentation = Pick<
  ApplicationHomeSurfaceProps,
  | "agentRoster"
  | "agentSelection"
  | "agentInputActive"
  | "onSelectAgent"
  | "onMoveAgent"
  | "onAgentViewport"
  | "onOpenAgent"
  | "onRetryAgents"
  | "onLoadMoreAgents"
>;

/** Observe the existing client, never open a second shell or poll for readiness. */
function waitForHomeAgentSemantic(
  generation: () => OpenTuiGenerationHostSnapshot | null,
  expectedKey: string,
  signal: AbortSignal,
): Promise<boolean> {
  const client = generation()?.client;
  if (!client || signal.aborted) return Promise.resolve(false);
  const ready = () =>
    applicationGenerationNavigationKey(generation()) !== expectedKey ||
    Boolean(client.getSnapshot().semantic);
  // A changed generation is settled, not admitted: the navigator revalidates it.
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const stops: (() => void)[] = [];
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      for (const stop of stops) stop();
      resolve(value);
    };
    const abort = () => finish(false);
    const check = () => {
      if (ready()) finish(true);
    };
    const timeout = setTimeout(() => finish(false), 5_000);
    signal.addEventListener("abort", abort, { once: true });
    // subscribe may synchronously deliver its current projection.
    for (const scope of ["semantic", "lifecycle"] as const) {
      if (settled) break;
      const stop = client.subscribe(scope, check);
      if (settled) stop();
      else stops.push(stop);
    }
    if (signal.aborted) abort();
    else check();
  });
}

/** Resident feature composition: observation, selection, and navigation have separate owners. */
export function createApplicationHomeAgentsOwner(options: {
  readonly catalog: Accessor<ApplicationHomeCatalogSnapshot>;
  readonly active: Accessor<boolean>;
  readonly inputActive: Accessor<boolean>;
  readonly generation: () => OpenTuiGenerationHostSnapshot | null;
  readonly sessionName: () => string | null;
  readonly startGeneration: ReturnType<typeof createApplicationGenerationStarter>;
  readonly selectPane: (paneId: string) => void;
  readonly showTerminals: (source: "keyboard" | "mouse") => void;
  readonly restoreHome?: (source: "keyboard" | "mouse") => Promise<void> | void;
  readonly setNote: (note: string | null) => void;
  readonly observer?: ApplicationHomeAgentObserver;
}) {
  const observer = options.observer ?? createApplicationHomeAgentObserver();
  const selection = createHomeAgentSelectionOwner();
  const [snapshot, setSnapshot] = createSignal(observer.getSnapshot());
  const [selected, setSelected] = createSignal(selection.snapshot());
  const [opening, setOpening] = createSignal(false);
  let request = 0;
  const navigator = createApplicationHomeAgentNavigator({
    isCurrentTarget(target) {
      const catalog = options.catalog();
      return (
        catalog.phase === "live" &&
        catalog.daemonInstanceId === target.daemonInstanceId &&
        catalog.sessions.some(
          (session) =>
            session.name === target.sessionName && session.liveSessionId === target.liveSessionId,
        ) &&
        observer.isCurrentTarget(target)
      );
    },
    currentGeneration() {
      const generation = options.generation();
      const generationKey = applicationGenerationNavigationKey(generation);
      const semantic = generation?.client?.getSnapshot().semantic;
      const sessionName = options.sessionName();
      if (!generationKey || !generation?.daemonGeneration || !semantic || !sessionName) return null;
      return {
        generationKey,
        daemonInstanceId: generation.daemonGeneration,
        liveSessionId: generation.connection?.liveSessionId ?? null,
        sessionName,
        agents: semantic.sidebar.agents,
      };
    },
    waitForGeneration: (key, signal) => waitForHomeAgentSemantic(options.generation, key, signal),
    startGeneration: options.startGeneration,
    // The existing pane input router is source-neutral. Session/surface intents
    // above retain keyboard vs pointer provenance without inventing a second router.
    selectPane: (paneId) => options.selectPane(paneId),
    showTerminals: options.showTerminals,
    setNote: options.setNote,
  });
  const stopSelection = selection.subscribe(setSelected);
  const stopObserver = observer.subscribe((next) => {
    setSnapshot(next);
    // A transient refresh or hidden Home is not evidence that the selection disappeared.
    if (
      next.phase === "live" ||
      (next.phase === "partial" && next.loadingSessions === 0) ||
      selected().selectedKey === null ||
      next.rows.some((row) => row.key === selected().selectedKey)
    )
      selection.setRows(next.rows);
  });
  createEffect(() => observer.adoptCatalog(options.catalog()));
  createEffect(() => observer.setActive(options.active() || opening()));
  const cancel = () => {
    request++;
    navigator.cancel();
    setOpening(false);
  };
  const presentation: ApplicationHomeAgentPresentation = {
    get agentRoster() {
      return snapshot();
    },
    get agentSelection() {
      return selected();
    },
    get agentInputActive() {
      return options.inputActive() && !opening();
    },
    onSelectAgent: selection.select,
    onMoveAgent: selection.move,
    onAgentViewport: selection.setViewport,
    onOpenAgent(row, source) {
      const token = ++request;
      selection.select(row.key);
      setOpening(true);
      void navigator
        .open(row, source)
        .then(async (result) => {
          if (token === request && !result.opened && result.failure !== "superseded")
            await options.restoreHome?.(source);
        })
        .finally(() => {
          if (token === request) setOpening(false);
        });
    },
    onRetryAgents: observer.retry,
    onLoadMoreAgents: observer.loadMore,
  };
  onCleanup(() => {
    untrack(cancel);
    stopObserver();
    stopSelection();
    navigator.dispose();
    observer.dispose();
    selection.dispose();
  });
  return { presentation, opening, cancel };
}

/** Compose Home navigation with competing chrome intents; physical input stays in the root. */
export function createApplicationHomeNavigationOwner(options: {
  readonly catalog: {
    readonly snapshot: Accessor<ApplicationHomeCatalogSnapshot>;
    readonly sessionNames: Accessor<string[]>;
  };
  readonly activeSurface: Accessor<"home" | "terminals">;
  readonly shell: Accessor<ReturnType<ApplicationShellBinding["getSnapshot"]>>;
  readonly binding: ApplicationShellBinding;
  readonly sessionOwner: () => OpenTuiSessionOwner | null;
  readonly generationStarter: ReturnType<typeof createApplicationGenerationStarter>;
  readonly startGeneration: ReturnType<typeof createApplicationGenerationStarter>;
  readonly interaction: Pick<
    ReturnType<typeof createApplicationTerminalInteractionController>,
    "selectPane" | "renamePane" | "newWindow" | "splitPane" | "closePane"
  >;
  readonly rendererFocused: Accessor<boolean>;
  readonly setSurface: (surface: "home" | "terminals") => void;
  readonly setNote: (note: string | null) => void;
  readonly observer?: ApplicationHomeAgentObserver;
}) {
  const openAgent = createApplicationAgentNavigator({
    startGeneration: options.generationStarter,
    sessionOwner: () => options.sessionOwner()!,
    selectPane: options.interaction.selectPane,
  });
  const paneRename = createApplicationPaneRenameOwner(
    options.interaction.renamePane,
    options.setNote,
  );
  const homeAgents = createApplicationHomeAgentsOwner({
    catalog: options.catalog.snapshot,
    active: () => options.activeSurface() === "home",
    inputActive: () =>
      options.activeSurface() === "home" &&
      !paneRename.draft() &&
      !options.shell().semantic?.focus.palette.open &&
      !options.shell().localPaletteOpen &&
      options.rendererFocused(),
    generation: () => options.sessionOwner()?.snapshot() ?? null,
    sessionName: () => options.sessionOwner()?.sessionName() ?? null,
    startGeneration: options.generationStarter,
    selectPane: options.interaction.selectPane,
    showTerminals: (source) => {
      void options.binding
        .openSurface("terminals", { kind: source, surface: "application-bar" })
        .then((dispatched) => {
          if (!dispatched) options.setSurface("terminals");
        });
    },
    restoreHome: async (source) => {
      const dispatched = await options.binding
        .openSurface("home", { kind: source, surface: "application-bar" })
        .catch(() => false);
      if (!dispatched) options.setSurface("home");
    },
    setNote: options.setNote,
    observer: options.observer,
  });
  const paletteCommands = createApplicationPaletteCommandOwner({
    activeSurface: options.activeSurface,
    binding: options.binding,
    commandSource: applicationPaletteCommandSource,
    setSurface: options.setSurface,
    setNote: options.setNote,
    newWindow: options.interaction.newWindow,
    splitPane: options.interaction.splitPane,
    closePane: options.interaction.closePane,
    openAgent,
    openSession: (name, source) => options.startGeneration(name, false, source),
    onNavigationIntent: homeAgents.cancel,
  });
  const paletteCommandList = createMemo(() =>
    applicationPaletteCommands(options.shell().semantic, options.catalog.sessionNames()),
  );
  return { homeAgents, paneRename, paletteCommands, paletteCommandList, openAgent };
}
