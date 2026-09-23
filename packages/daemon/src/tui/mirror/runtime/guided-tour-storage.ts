import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeOwnedPath } from "../../../lib/runtime-namespace.ts";
import { stateHome } from "../../../lib/state-home.ts";
import { GUIDED_TOUR_STEPS, initialGuidedTourState, type GuidedTourState } from "./guided-tour.ts";

export function guidedTourStatePath(): string {
  return runtimeOwnedPath(join(stateHome(), "guided-tour.json"));
}
export function parseGuidedTourState(value: unknown): GuidedTourState {
  if (!value || typeof value !== "object") return initialGuidedTourState();
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    !GUIDED_TOUR_STEPS.includes(raw.step as GuidedTourState["step"]) ||
    typeof raw.active !== "boolean"
  )
    return initialGuidedTourState();
  let practice: GuidedTourState["practice"] = null;
  if (raw.practice && typeof raw.practice === "object") {
    const p = raw.practice as Record<string, unknown>;
    if (
      [p.machineId, p.serverId, p.generation, p.sessionId, p.sessionName].every(
        (v) => typeof v === "string" && v.length > 0,
      )
    ) {
      practice = {
        machineId: p.machineId as string,
        serverId: p.serverId as string,
        generation: p.generation as string,
        sessionId: p.sessionId as string,
        sessionName: p.sessionName as string,
      };
    }
  }
  const step = raw.step as GuidedTourState["step"];
  return {
    version: 1,
    step: !practice && !["welcome", "practice", "complete"].includes(step) ? "practice" : step,
    active: raw.active,
    practice,
  };
}
export function readGuidedTourState(path = guidedTourStatePath()): GuidedTourState {
  try {
    return parseGuidedTourState(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return initialGuidedTourState();
  }
}
/** Atomic, best-effort persistence; failure must not prevent using terminals. */
export function writeGuidedTourState(
  state: GuidedTourState,
  path = guidedTourStatePath(),
): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* Best effort. */
    }
  }
}
