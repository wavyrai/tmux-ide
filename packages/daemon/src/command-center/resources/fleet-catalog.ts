/**
 * The fleet-catalog resource projector — turns the daemon's live enumeration of
 * the adopted tmux fleet (see `discovery.ts` `readAdoptedFleet`) into the
 * read-only, path-free {@link FleetCatalogResourceV1} contract.
 *
 * PURE and TOTAL: it never throws and never scrapes. Identity, labels and caps
 * are enforced by construction so the final resource always satisfies the
 * contract schema —
 *  - session/agent ids are opaque `session.<token>` / `agent.<token>` digests,
 *    never a raw tmux id, name or path;
 *  - every label is control-stripped, whitespace-collapsed and clamped, and a
 *    `projectLabel` is a directory BASENAME (slashes removed) — never a path;
 *  - fleet-scale caps ({@link FLEET_MAX_SESSIONS} etc.) pre-trim the enumeration
 *    so an oversized fleet degrades to the documented ceiling rather than a
 *    schema rejection.
 *
 * Agent classification and status reuse the SAME kernel the desktop shell
 * projection uses ({@link isAgentPane} + {@link resolveAgentPresentation}), so
 * the fleet speaks one status language with the rest of the product. Because the
 * product decision for unopened sessions is authority-only, every pane is
 * resolved with `agentScrapeState: null` — a fresh `@agent_state` stamp yields
 * its status, and an unstamped agent pane settles to `unknown`/`disconnected`
 * WITHOUT any capture round-trip.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  FLEET_CATALOG_RESOURCE_VERSION,
  FLEET_LABEL_MAX_LENGTH,
  FLEET_MAX_AGENTS_PER_SESSION,
  FLEET_MAX_PANES_PER_SESSION,
  FLEET_MAX_SESSIONS,
  FLEET_MAX_TOTAL_AGENTS,
  FleetCatalogResourceV1SchemaZ,
  type DaemonInstanceIdentity,
  type FleetCatalogAgentEntryV1,
  type FleetCatalogResourceV1,
  type FleetCatalogSessionEntryV1,
} from "@tmux-ide/contracts";
import type { FleetSessionFacts } from "../discovery.ts";
import {
  harnessForPane,
  isAgentPane,
  resolveAgentPresentation,
  type ApplicationShellPanePresentationFacts,
} from "./application-shell.ts";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

/**
 * Mint the opaque fleet session id for a live tmux session name. The SINGLE
 * source of truth for `session.<digest>`: the catalog projector emits it and the
 * promotion authority reverses it (enumerate live names, mint each, match the
 * requested id) so a fleet id can be resolved to a session daemon-side without
 * ever accepting a raw session name from the wire.
 */
export function fleetSessionIdForName(sessionName: string): string {
  return `session.${digest(sessionName)}`;
}

/**
 * Control-strip, collapse whitespace and clamp a candidate label to a valid
 * {@link FleetLabelSchemaZ} value; falls back when nothing printable remains.
 * Strips code points <= 31 and 127-159 (a superset of the contract's control
 * rejection), guaranteeing the result passes the schema's `isControlFree` gate.
 */
function fleetLabel(value: string | null | undefined, fallback: string): string {
  const stripped = Array.from(value ?? "", (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
  }).join("");
  const normalized = stripped.replace(/\s+/gu, " ").trim().slice(0, FLEET_LABEL_MAX_LENGTH);
  return normalized || fallback;
}

/**
 * A project label is a directory BASENAME: take the basename, then remove any
 * residual path separators (a leftover `\` on posix) and control characters so
 * a path can never be smuggled onto the wire.
 */
function fleetProjectLabel(cwd: string, fallback: string): string {
  const base = basename(cwd).replace(/[/\\]/gu, "");
  return fleetLabel(base, fallback);
}

function toPresentationPane(
  pane: FleetSessionFacts["panes"][number],
  index: number,
): ApplicationShellPanePresentationFacts {
  return {
    semanticPaneId: null,
    index,
    title: "",
    currentCommand: pane.currentCommand,
    active: pane.active,
    role: null,
    name: null,
    type: null,
    agentStateRaw: pane.agentStateRaw,
    agentStatusTextRaw: pane.agentStatusTextRaw,
    agentDisplayNameRaw: pane.agentDisplayNameRaw,
    // Authority-only: the fleet never scrapes an unopened session. `null` (not
    // `undefined`) keeps `resolveAgentPresentation` on the ground-truth path
    // while its scrape verdict resolves to `unknown` without any capture.
    agentScrapeState: null,
  };
}

function projectSession(
  session: FleetSessionFacts,
  nowSec: number,
  remainingAgentBudget: number,
): FleetCatalogSessionEntryV1 {
  const agents: FleetCatalogAgentEntryV1[] = [];
  for (const [index, pane] of session.panes.entries()) {
    if (agents.length >= FLEET_MAX_AGENTS_PER_SESSION || agents.length >= remainingAgentBudget) {
      break;
    }
    const presentationPane = toPresentationPane(pane, index);
    if (!isAgentPane(presentationPane)) continue;
    const presentation = resolveAgentPresentation(presentationPane, nowSec);
    agents.push({
      agentId: `agent.${digest(`${session.name}\u0000${pane.runtimePaneId}`)}`,
      name: fleetLabel(presentation.displayName ?? pane.currentCommand, `Agent ${index + 1}`),
      harness: harnessForPane(presentationPane),
      activity: presentation.activity,
      attention: presentation.attention,
      statusSource: presentation.statusSource,
    });
  }
  return {
    sessionId: fleetSessionIdForName(session.name),
    label: fleetLabel(session.name, "session"),
    projectLabel: fleetProjectLabel(session.cwd, fleetLabel(session.name, "workspace")),
    appCreated: session.appCreated,
    paneCount: Math.min(session.panes.length, FLEET_MAX_PANES_PER_SESSION),
    agents,
  };
}

/**
 * Project the enumerated adopted fleet into the read-only catalog resource.
 * PURE and TOTAL — see the module header. Sessions and agents are pre-trimmed to
 * the contract caps in enumeration order; the returned resource is parsed
 * through {@link FleetCatalogResourceV1SchemaZ} as a construction assertion.
 */
export function projectFleetCatalog(
  sessions: readonly FleetSessionFacts[],
  daemon: DaemonInstanceIdentity,
  nowSec: number,
): FleetCatalogResourceV1 {
  const projected: FleetCatalogSessionEntryV1[] = [];
  let totalAgents = 0;
  for (const session of sessions) {
    if (projected.length >= FLEET_MAX_SESSIONS) break;
    const entry = projectSession(session, nowSec, FLEET_MAX_TOTAL_AGENTS - totalAgents);
    totalAgents += entry.agents.length;
    projected.push(entry);
  }
  return FleetCatalogResourceV1SchemaZ.parse({
    version: FLEET_CATALOG_RESOURCE_VERSION,
    daemon,
    sessions: projected,
  });
}
