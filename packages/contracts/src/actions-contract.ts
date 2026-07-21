/**
 * Action contract for the v2 dispatcher.
 *
 * CLI and command-center clients import the schemas in this file — input +
 * output Zod shapes for every action. The server-side dispatcher wires each
 * name to a handler that consumes the input and returns the typed result.
 *
 * Adding a new action:
 *  1. Define `<Name>InputSchemaZ` and `<Name>ResultSchemaZ` here
 *  2. Add it to {@link ActionContractsZ} below
 *  3. Add a handler in `handlers/` and register it in `registry.ts`
 *
 * Invariants:
 *  - Names are dot-namespaced (`<noun>.<verb>`)
 *  - Both schemas live here so the wire format never drifts between clients
 *  - Action names ARE the discriminator — keep them stable; never rename
 */

import { z } from "zod";
import { IdeConfigSchema, PaneSchema } from "./ide-config.ts";

// ---------------------------------------------------------------------------
// project.openTerminal
// ---------------------------------------------------------------------------

export const ProjectOpenTerminalInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectOpenTerminalResultZ = z.object({
  sessionName: z.string(),
  cwd: z.string().min(1),
  terminalTabId: z.string(),
  /**
   * `true` when the dispatcher had to launch the tmux session as part of
   * resolving the terminal. `false` when the session was already running.
   */
  launched: z.boolean(),
});

// ---------------------------------------------------------------------------
// project.launch
// ---------------------------------------------------------------------------

export const ProjectLaunchInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectLaunchResultZ = z.object({
  sessionName: z.string(),
  /**
   * `false` when the session was already running (idempotent no-op),
   * `true` when this call started a fresh session.
   */
  started: z.boolean(),
});

// ---------------------------------------------------------------------------
// project.stop
// ---------------------------------------------------------------------------

export const ProjectStopInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectStopResultZ = z.object({
  sessionName: z.string(),
  /**
   * `false` when no session was running (idempotent no-op),
   * `true` when this call killed a session.
   */
  stopped: z.boolean(),
});

// ---------------------------------------------------------------------------
// project.restart
// ---------------------------------------------------------------------------

export const ProjectRestartInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectRestartResultZ = z.object({
  sessionName: z.string(),
  restarted: z.literal(true),
});

// ---------------------------------------------------------------------------
// project.activate
// ---------------------------------------------------------------------------

export const ProjectActivateInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectActivateResultZ = z.object({
  active: z.boolean(),
  projectName: z.string(),
});

// ---------------------------------------------------------------------------
// terminal.respawn
// ---------------------------------------------------------------------------

export const TerminalRespawnInputZ = z.object({
  sessionName: z.string().min(1),
  terminalId: z.string().min(1),
  /**
   * Optional cwd override. Omit to respawn at the bridge's current cwd
   * (re-using the `lastCwd` recorded by the PTY bridge).
   */
  cwd: z.string().min(1).optional(),
});
export const TerminalRespawnResultZ = z.object({
  respawned: z.literal(true),
  cwd: z.string().min(1),
});

// ---------------------------------------------------------------------------
// terminal.stop
// ---------------------------------------------------------------------------

export const TerminalStopInputZ = z.object({
  sessionName: z.string().min(1),
  terminalId: z.string().min(1),
});
export const TerminalStopResultZ = z.object({
  stopped: z.literal(true),
});

// ---------------------------------------------------------------------------
// config.*
// ---------------------------------------------------------------------------

export const ConfigSetInputZ = z.object({
  projectName: z.string().min(1).optional(),
  path: z.string().min(1),
  value: z.unknown(),
});
export const ConfigResultZ = z.object({
  config: IdeConfigSchema,
});

export const ConfigAddPaneInputZ = PaneSchema.partial().extend({
  projectName: z.string().min(1).optional(),
  rowIndex: z.number().int().min(0),
});
export const ConfigAddPaneResultZ = ConfigResultZ;

export const ConfigRemovePaneInputZ = z.object({
  projectName: z.string().min(1).optional(),
  rowIndex: z.number().int().min(0),
  paneIndex: z.number().int().min(0),
});
export const ConfigRemovePaneResultZ = ConfigResultZ;

export const ConfigAddRowInputZ = z.object({
  projectName: z.string().min(1).optional(),
  size: z.string().optional(),
});
export const ConfigAddRowResultZ = ConfigResultZ;

export const ConfigEnableTeamInputZ = z.object({
  projectName: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
export const ConfigEnableTeamResultZ = ConfigResultZ;

export const ConfigDisableTeamInputZ = z.object({
  projectName: z.string().min(1).optional(),
});
export const ConfigDisableTeamResultZ = ConfigResultZ;

// ---------------------------------------------------------------------------
// app.*
// ---------------------------------------------------------------------------

export const AppSetRemoteAccessInputZ = z.object({
  enabled: z.boolean(),
});
export const AppSetRemoteAccessResultZ = z.object({
  enabled: z.boolean(),
  url: z.string().nullable(),
  token: z.string().nullable(),
  qrPayload: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// daemon.*
// ---------------------------------------------------------------------------

export const DaemonShutdownInputZ = z.object({
  reason: z.string().optional(),
  expectedInstanceId: z.uuid().optional(),
});
export const DaemonShutdownResultZ = z.object({
  stopping: z.literal(true),
});

// ---------------------------------------------------------------------------
// Registry of action contracts (name → input/output schemas)
// ---------------------------------------------------------------------------

export const ActionContractsZ = {
  "project.openTerminal": {
    input: ProjectOpenTerminalInputZ,
    result: ProjectOpenTerminalResultZ,
  },
  "project.launch": {
    input: ProjectLaunchInputZ,
    result: ProjectLaunchResultZ,
  },
  "project.stop": {
    input: ProjectStopInputZ,
    result: ProjectStopResultZ,
  },
  "project.restart": {
    input: ProjectRestartInputZ,
    result: ProjectRestartResultZ,
  },
  "project.activate": {
    input: ProjectActivateInputZ,
    result: ProjectActivateResultZ,
  },
  "terminal.respawn": {
    input: TerminalRespawnInputZ,
    result: TerminalRespawnResultZ,
  },
  "terminal.stop": {
    input: TerminalStopInputZ,
    result: TerminalStopResultZ,
  },
  "config.set": {
    input: ConfigSetInputZ,
    result: ConfigResultZ,
  },
  "config.addPane": {
    input: ConfigAddPaneInputZ,
    result: ConfigAddPaneResultZ,
  },
  "config.removePane": {
    input: ConfigRemovePaneInputZ,
    result: ConfigRemovePaneResultZ,
  },
  "config.addRow": {
    input: ConfigAddRowInputZ,
    result: ConfigAddRowResultZ,
  },
  "config.enableTeam": {
    input: ConfigEnableTeamInputZ,
    result: ConfigEnableTeamResultZ,
  },
  "config.disableTeam": {
    input: ConfigDisableTeamInputZ,
    result: ConfigDisableTeamResultZ,
  },
  "app.setRemoteAccess": {
    input: AppSetRemoteAccessInputZ,
    result: AppSetRemoteAccessResultZ,
  },
  "daemon.shutdown": {
    input: DaemonShutdownInputZ,
    result: DaemonShutdownResultZ,
  },
} as const;

export type ActionName = keyof typeof ActionContractsZ;

export const ACTION_NAMES = Object.keys(ActionContractsZ) as ActionName[];

// ---------------------------------------------------------------------------
// Typed input / result helpers
// ---------------------------------------------------------------------------

export type ActionInput<N extends ActionName> = z.infer<(typeof ActionContractsZ)[N]["input"]>;
export type ActionResult<N extends ActionName> = z.infer<(typeof ActionContractsZ)[N]["result"]>;

// ---------------------------------------------------------------------------
// Wire envelope (what the HTTP endpoint actually returns)
// ---------------------------------------------------------------------------

export interface ActionErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ActionOkEnvelope<R> {
  ok: true;
  result: R;
}

export type ActionResponse<N extends ActionName> =
  | ActionOkEnvelope<ActionResult<N>>
  | ActionErrorEnvelope;

/**
 * Validate that a string is a known action name. Used by the dispatcher to
 * narrow URL params before looking up the handler.
 */
export function isActionName(name: string): name is ActionName {
  return name in ActionContractsZ;
}

/**
 * Helper for a tagged WS broadcast frame so subscribers can decode without
 * special-casing every action name.
 */
export interface ActionCompleteFrame<N extends ActionName = ActionName> {
  type: "action.complete";
  name: N;
  result: ActionResult<N>;
}
