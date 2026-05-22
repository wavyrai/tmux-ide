/**
 * Handler: `terminal.respawn`.
 *
 * Server-side equivalent of the dashboard's `bridge.restartWith(...)` call.
 * Looks up the PTY bridge by id; if a cwd is supplied it validates the
 * directory and passes it through; otherwise it respawns at the bridge's
 * recorded `lastCwd`.
 *
 * Why server-side? The dashboard previously had to do the cwd resolution
 * itself before it could ask the bridge to restart. Centralising it here
 * keeps the cwd contract on the server, where it has direct access to the
 * project registry and the bridge's filesystem.
 */

import {
  defaultPtyBridgeRegistry as defaultRegistry,
  type PtyBridgeLike,
  type PtyBridgeRegistry,
} from "../../../server/ws-route.ts";
import { assertValidCwd, TerminalCwdError } from "../../../server/pty-bridge.ts";
import type { Stats } from "node:fs";
import { ActionError, actionErrorFromCwdError } from "../errors.ts";
import { type ActionInput, type ActionResult } from "../contract.ts";

const DEFAULT_RESPAWN_COLS = 80;
const DEFAULT_RESPAWN_ROWS = 24;

export interface TerminalRespawnDeps {
  registry?: PtyBridgeRegistry;
  /** Override for the bridge dimensions used on respawn. Tests inject these. */
  cols?: number;
  rows?: number;
  statCwd?: (cwd: string) => Stats;
}

export function terminalRespawnHandler(
  input: ActionInput<"terminal.respawn">,
  deps: TerminalRespawnDeps = {},
): ActionResult<"terminal.respawn"> {
  const registry = deps.registry ?? defaultRegistry;
  const bridge = registry.peek(input.terminalId) as RespawnCapableBridge | null;
  if (!bridge) {
    throw new ActionError({
      code: "terminal_not_found",
      message: `No running terminal bridge for id "${input.terminalId}"`,
      details: { terminalId: input.terminalId, sessionName: input.sessionName },
    });
  }
  if (!bridge.restartWith) {
    throw new ActionError({
      code: "internal",
      message: "Bridge does not support restartWith",
      details: { terminalId: input.terminalId },
    });
  }

  const cwd = resolveRespawnCwd(input, bridge, deps.statCwd);
  const cols = deps.cols ?? bridge.cols ?? DEFAULT_RESPAWN_COLS;
  const rows = deps.rows ?? bridge.rows ?? DEFAULT_RESPAWN_ROWS;

  try {
    bridge.restartWith(cols, rows, { cwd });
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw new ActionError({
      code: "internal",
      message: `Failed to respawn terminal "${input.terminalId}": ${(err as Error).message ?? String(err)}`,
      details: { terminalId: input.terminalId },
      cause: err,
    });
  }

  return { respawned: true, cwd };
}

interface RespawnCapableBridge extends PtyBridgeLike {
  cols?: number | null;
  rows?: number | null;
}

function resolveRespawnCwd(
  input: ActionInput<"terminal.respawn">,
  bridge: RespawnCapableBridge,
  statCwd?: (cwd: string) => Stats,
): string {
  if (input.cwd) {
    try {
      assertValidCwd(input.cwd, statCwd);
    } catch (err) {
      if (err instanceof TerminalCwdError) {
        throw actionErrorFromCwdError(err);
      }
      throw err;
    }
    return input.cwd;
  }

  const last = bridge.getCwd?.() ?? null;
  if (!last) {
    throw new ActionError({
      code: "internal",
      message: "Cannot respawn terminal without an explicit cwd: bridge has no recorded cwd",
      details: { terminalId: input.terminalId },
    });
  }
  // Validate the recorded cwd too — the directory may have been deleted
  // since the bridge first spawned.
  try {
    assertValidCwd(last, statCwd);
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw err;
  }
  return last;
}
