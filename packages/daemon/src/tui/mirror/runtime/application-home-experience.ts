import { createApplicationPluginCommands } from "./application-plugin-commands.ts";
import { createEffect, type Accessor } from "solid-js";
import { createApplicationHomeFleetOwner } from "./application-home-fleet.ts";
import { createApplicationHomeNavigationOwner } from "./application-home-agents-owner.ts";
import type { createApplicationGuidedTourIntegration } from "./application-guided-tour-integration.tsx";

import { createLazyApplicationGuidedTour } from "./application-guided-tour-lazy.tsx";
import type { GuidedTourPreparation } from "./application-guided-tour-preparation.ts";

type NavigationOptions = Parameters<typeof createApplicationHomeNavigationOwner>[0];
type TourOptions = Parameters<typeof createApplicationGuidedTourIntegration>[0];
/** A late modal dismissal must not restore focus into Home's hidden sidebar. */
export function createHomeSidebarFocusGuard(
  surface: Accessor<"home" | "terminals">,
  focused: Accessor<boolean>,
  blur: () => void,
  sidebarVisible: Accessor<boolean> = () => true,
) {
  createEffect(() => {
    if ((surface() === "home" || !sidebarVisible()) && focused()) blur();
  });
}

/** Compose Home's fleet, navigation and learning experience without additional transports. */
export function createApplicationHomeExperience(
  options: Omit<NavigationOptions, "fleetHome" | "fleetCommands" | "openFleet"> &
    Pick<
      TourOptions,
      | "machines"
      | "lifecycle"
      | "generation"
      | "generationMachineId"
      | "layoutSnapshot"
      | "appearance"
      | "dimensions"
    > & { paletteModalOpen: Accessor<boolean>; guidedTourPreparation: GuidedTourPreparation },
) {
  const { machines, appearance } = options;
  createHomeSidebarFocusGuard(
    options.activeSurface,
    machines.focused,
    () => machines.sidebar.onBlur?.(),
    options.sidebarVisible,
  );
  const paletteOpen = () =>
    options.shell().semantic?.focus.palette.open ?? options.shell().localPaletteOpen;
  const fleetHome = createApplicationHomeFleetOwner({
    catalog: machines.catalog,
    agents: machines.agents,
    inputActive: () =>
      options.activeSurface() === "home" &&
      options.rendererFocused() &&
      !options.paletteModalOpen() &&
      !machines.switching() &&
      !machines.adding() &&
      !machines.focused() &&
      !paletteOpen() &&
      !appearance.pickerOpen(),
    open: (_machineId, agent, source) => machines.openHomeAgent(agent, source),
  });
  const navigation = createApplicationHomeNavigationOwner({
    ...options,
    fleetHome: fleetHome.presentation,
    fleetCommands: machines.paletteCommands,
    openFleet: machines.openPalette,
    openSessions: () => machines.showSwitcher(false),
    pluginCommands: createApplicationPluginCommands(),
  });
  const tour = createLazyApplicationGuidedTour(
    {
      ...options,
      sessionName: () => options.sessionOwner()?.sessionName() ?? null,
      paletteOpen,
      paletteCommands: navigation.paletteCommands,
      blocked: () =>
        options.paletteModalOpen() ||
        !!navigation.paneRename.draft() ||
        !!navigation.newAgent.draft() ||
        paletteOpen() ||
        appearance.pickerOpen() ||
        machines.switching() ||
        machines.adding(),
    },
    options.guidedTourPreparation,
    options.setNote,
  );
  return { ...navigation, tour };
}
