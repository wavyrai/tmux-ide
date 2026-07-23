/**
 * The stable environment identity — a UUID minted ONCE per daemon state home
 * and preserved across every daemon restart. It answers "which environment is
 * this?" for clients that keep their own catalog of access endpoints, while
 * `instanceId`/`startedAt` remain the per-process generation nonce and keep
 * sole authority over generation checks.
 *
 * Persistence follows the state-home discipline (`TMUX_IDE_HOME` when set,
 * else `~/.tmux-ide`): the read degrades to a re-mint on anything absent,
 * unreadable, or malformed, and a failed write only costs stability across
 * restarts — the freshly minted id still identifies this process lifetime,
 * which is exactly the pre-environment-identity world. Never throws.
 */
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateHome } from "./state-home.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Absolute path to the identity file: `<state-home>/environment.json`. */
export function environmentIdentityPath(): string {
  return join(stateHome(), "environment.json");
}

function readPersistedEnvironmentId(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const id = (parsed as { environmentId?: unknown }).environmentId;
    return typeof id === "string" && UUID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

function persistEnvironmentId(path: string, environmentId: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      temporary,
      `${JSON.stringify({ environmentId, mintedAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    // link(2) is create-if-absent: a concurrent minter cannot overwrite an
    // already-published identity, so every process converges on one id.
    linkSync(temporary, path);
  } catch {
    // Persistence is best-effort; the minted id below still identifies this
    // process lifetime, and the next start simply mints again.
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The stray temp file is harmless.
    }
  }
}

/**
 * Return the environment id for this daemon home, minting and persisting one
 * when no valid record exists. A concurrent minter is resolved by re-reading
 * after publication: the id on disk wins so every process converges on one
 * identity.
 */
export function readOrMintEnvironmentId(): string {
  const path = environmentIdentityPath();
  const existing = readPersistedEnvironmentId(path);
  if (existing) return existing;
  try {
    // A malformed record would otherwise block create-if-absent publication
    // forever; healing it restores a stable identity from the next line on.
    rmSync(path, { force: true });
  } catch {
    // Unremovable state degrades to a per-process id, never a crash.
  }
  const minted = randomUUID();
  persistEnvironmentId(path, minted);
  return readPersistedEnvironmentId(path) ?? minted;
}
