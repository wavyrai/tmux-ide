import type { DockToolId, ProductSurfaceId } from "@tmux-ide/contracts";

/**
 * The GUI-first scope call (m48).
 *
 * The product is a GUI around tmux: the terminal canvas is the driver, Files
 * and Changes ride along, and the orchestration surfaces wait their turn. This
 * flag withholds the Missions and Activity dock tabs and their bodies — it
 * deletes nothing. Their contracts, daemon routes, projections, stores and
 * tests all stay live and green underneath, so the decision is a setting to
 * flip rather than a branch to revert.
 *
 * Off by default. Turn them on without rebuilding, either way:
 *
 *   ?tmux-ide.experimental-surfaces=1        on the renderer URL
 *   localStorage["tmux-ide.experimental-surfaces"] = "1"
 *
 * The URL wins over storage so a single window can be opened with the surfaces
 * on without changing what every other window shows.
 */
export const EXPERIMENTAL_DOCK_TOOLS: readonly DockToolId[] = Object.freeze([
  "missions",
  "activity",
]);

export const EXPERIMENTAL_SURFACES_FLAG = "tmux-ide.experimental-surfaces";

export interface ExperimentalSurfacesFlagSource {
  /** `window.location.search`, or any query string. */
  readonly search?: string;
  readonly storage?: Pick<Storage, "getItem"> | null;
}

const TRUE_VALUES = Object.freeze(["1", "true", "on", "yes"]);
const FALSE_VALUES = Object.freeze(["0", "false", "off", "no"]);

/** An unrecognised value is not a vote; it falls through to the next source. */
function parseFlag(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().toLocaleLowerCase();
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  return null;
}

export function readExperimentalSurfacesEnabled(
  source: ExperimentalSurfacesFlagSource = {},
): boolean {
  const fromSearch = parseFlag(
    new URLSearchParams(source.search ?? "").get(EXPERIMENTAL_SURFACES_FLAG),
  );
  if (fromSearch !== null) return fromSearch;
  let stored: string | null;
  try {
    // A packaged renderer can have storage denied; an unreadable setting is a
    // missing setting, never a crash on the way to the first paint.
    stored = source.storage?.getItem(EXPERIMENTAL_SURFACES_FLAG) ?? null;
  } catch {
    stored = null;
  }
  return parseFlag(stored) ?? false;
}

/** The live browser reading of the flag. Server/test contexts read as off. */
export function experimentalSurfacesEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return readExperimentalSurfacesEnabled({
    search: window.location.search,
    storage: window.localStorage,
  });
}

/**
 * The dock tools withheld at this flag setting; empty when the surfaces are on.
 *
 * Typed over the wider `ProductSurfaceId` so one set answers for both the dock
 * tool list and the projected surface list — every dock tool is a product
 * surface, and the callers that consult it work in either vocabulary.
 */
export function hiddenDockTools(enabled: boolean): ReadonlySet<ProductSurfaceId> {
  return new Set<ProductSurfaceId>(enabled ? [] : EXPERIMENTAL_DOCK_TOOLS);
}

export const NO_HIDDEN_DOCK_TOOLS: ReadonlySet<ProductSurfaceId> = new Set<ProductSurfaceId>();
