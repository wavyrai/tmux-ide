import type { Accessor } from "solid-js";
import { createApplicationHomeFleetOwner } from "./application-home-fleet.ts";
import { createApplicationHomeNavigationOwner } from "./application-home-agents-owner.ts";
import { createApplicationGuidedTourIntegration } from "./application-guided-tour-integration.tsx";

type NavigationOptions = Parameters<typeof createApplicationHomeNavigationOwner>[0];
type TourOptions = Parameters<typeof createApplicationGuidedTourIntegration>[0];
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
    > & { paletteModalOpen: Accessor<boolean> },
) {
  const { machines, appearance } = options;
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
  });
  const tour = createApplicationGuidedTourIntegration({
    ...options,
    sessionName: () => options.sessionOwner()?.sessionName() ?? null,
    paletteOpen,
    paletteCommands: navigation.paletteCommands,
    blocked: () =>
      options.paletteModalOpen() ||
      !!navigation.paneRename.draft() ||
      paletteOpen() ||
      appearance.pickerOpen() ||
      machines.switching() ||
      machines.adding(),
  });
  return { ...navigation, tour };
}
