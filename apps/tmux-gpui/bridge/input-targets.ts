import { previewInputSchema } from "./input.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { HistoryFrame } from "./history-restoration.ts";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";

export const inputTargetsSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(512),
        token: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  )
  .max(24)
  .superRefine((targets, ctx) => {
    if (new Set(targets.map((target) => target.id)).size !== targets.length)
      ctx.addIssue({ code: "custom", message: "Duplicate input target" });
  });
export type InputTarget = z.infer<typeof inputTargetsSchema>[number];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const proofSchema = z.object({
  workspaceName: z.string().min(1).max(512),
  semanticPaneId: z.string().min(1).max(512),
  generation: z.string().min(1).max(256),
  incarnation: z.string().min(1).max(256),
});
/** Call current only on canonical delivery receivers. A layout ID alone is not a lifetime. */
export function publishInputTargets(options: {
  enabled: boolean;
  connection: string;
  liveSessionId: string;
  workspaceName: string;
  surfaces: readonly { paneId: string; snapshot: TerminalReplicaSnapshot }[];
  current: (paneId: string) => HistoryFrame | null;
}): InputTarget[] {
  if (!options.enabled) return [];
  if (options.surfaces.length > 24) throw Error("Too many input target surfaces");
  const targets = options.surfaces.flatMap(({ paneId, snapshot }) => {
    const frame = options.current(paneId);
    if (!frame) return [];
    const proof = proofSchema.parse(frame.proof);
    if (proof.workspaceName !== options.workspaceName || proof.semanticPaneId !== paneId)
      throw Error("Input target canonical scope mismatch");
    if (
      frame.snapshot !== snapshot &&
      (frame.snapshot.cols !== snapshot.cols ||
        frame.snapshot.rows !== snapshot.rows ||
        frame.snapshot.grid.length !== snapshot.grid.length ||
        !frame.snapshot.grid.every((row, i) => row === snapshot.grid[i]))
    )
      return [];
    return [
      {
        id: paneId,
        token: digest([
          options.connection,
          options.liveSessionId,
          proof.workspaceName,
          paneId,
          proof.generation,
          proof.incarnation,
        ]),
      },
    ];
  });
  return inputTargetsSchema.parse(targets);
}
/** Validate child metadata and bind it to this browser connection. Navigation
 * request deliberately excluded: same-window selection must retain the fence.
 * Missing metadata from older helpers stays unsupported, never synthesized.
 */
export function bindInputTargets(
  value: unknown,
  connection: string,
  regionIds: readonly string[],
): InputTarget[] {
  if (value === undefined || value === null) return [];
  const targets = inputTargetsSchema.parse(value);
  if (targets.some((target) => !regionIds.includes(target.id)))
    throw Error("Input target outside coherent regions");
  return targets.map((target) => ({ id: target.id, token: digest([connection, target.token]) }));
}

/** A retained resize-skew canvas must not acquire new target lifetimes from a
 * newer surface. Only expose fences for cells actually represented on screen. */
export function visibleInputTargets(
  value: unknown,
  connection: string,
  surfaces: readonly { paneId: string; snapshot: TerminalReplicaSnapshot }[],
  presentation: import("./window-presentation.ts").WindowPresentation | null,
): InputTarget[] {
  const targets = inputTargetsSchema.parse(value ?? []);
  if (!presentation) return [];
  return bindInputTargets(
    targets,
    connection,
    presentation.regions.map((region) => region.id),
  ).filter((target) => {
    const snapshot = surfaces.find((surface) => surface.paneId === target.id)?.snapshot;
    return !!snapshot && presentation.representedSurfaces.get(target.id) === snapshot;
  });
}

export const fencedInputSchema = z
  .object({
    kind: z.literal("fenced-input"),
    id: z.string().min(1).max(512),
    inputTarget: z.string().regex(/^[a-f0-9]{64}$/),
    input: previewInputSchema,
  })
  .strict();
export function resolveInputTarget(
  value: string,
  id: string,
  bound: readonly InputTarget[],
  raw: readonly InputTarget[],
): string | null {
  if (bound.find((target) => target.id === id)?.token !== value) return null;
  return raw.find((target) => target.id === id)?.token ?? null;
}
export function inputTargetMatches(
  id: string,
  token: string,
  selected: string,
  current: (id: string) => string | null,
): boolean {
  return id === selected && current(id) === token;
}

/** Once rejected, a held transaction can never resume after authority returns. */
export function createInputTargetGuard(check: () => boolean, rejected: () => void) {
  let failed = false;
  return () => {
    if (failed) return false;
    if (check()) return true;
    failed = true;
    rejected();
    return false;
  };
}
