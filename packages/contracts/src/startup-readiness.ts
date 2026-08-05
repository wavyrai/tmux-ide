/**
 * The startup readiness ladder — the POSITIVE contract behind "is the app up?".
 *
 * Every surface that can be blocked during startup (the Electron shell, the
 * renderer, a live test, a support transcript) reads the same five ordered
 * rungs instead of inventing its own notion of "connected". Each rung is
 * `pending`, `satisfied`, or `stuck`, and a stuck rung carries a TYPED reason
 * drawn from the vocabulary that already owns that failure class — this file
 * deliberately defines no parallel spelling of a fault another contract already
 * names.
 *
 * The rungs, in strict order:
 *
 * 1. `daemon-spawned`        — a daemon process exists and answers.
 * 2. `credential-held`       — the owner capability (bearer) is held, so the
 *                              privileged resources can be read at all.
 * 3. `identity-established`  — a generation-stamped daemon identity is known.
 * 4. `catalog-populated`     — the semantic pane catalog was read, and either
 *                              yields at least one attachable pane OR is
 *                              honestly EMPTY. An empty fleet is NOT stuck:
 *                              nothing is broken when the user simply has no
 *                              adopted sessions yet (see
 *                              {@link StartupReadinessCatalogPopulationSchemaZ}).
 * 5. `attachment-issuable`   — the attachment runtime passed its startup
 *                              barrier, so a lease could be issued now.
 *
 * Ladder discipline (enforced by the schema, not by convention): rungs appear
 * exactly once, in canonical order, and no rung is `satisfied` above one that
 * is not. A ladder therefore reads top-down to exactly one blocking rung —
 * `blockedAt` — which is the single thing a user needs to be told.
 */
import { z } from "zod";

import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
// Read from the leaf module rather than desktop-host.ts: the host contract
// carries a ladder on its disconnected states, so importing it back here would
// make the two files evaluate each other.
import {
  DesktopDaemonHostIssueCodeSchemaZ,
  DaemonChildOutputTailSchemaZ,
  type DaemonChildOutputTail,
} from "./desktop-daemon-issue.ts";
import type { DesktopDaemonCapabilityState } from "./desktop-host.ts";
import { TerminalResourceUnavailableReasonSchemaZ } from "./application-shell.ts";
import { TerminalAttachmentIssueErrorCodeSchemaZ } from "./terminal-attachments.ts";

export const STARTUP_READINESS_RESOURCE_VERSION = 1 as const;

export const StartupReadinessRungIdSchemaZ = z.enum([
  "daemon-spawned",
  "credential-held",
  "identity-established",
  "catalog-populated",
  "attachment-issuable",
]);
export type StartupReadinessRungId = z.infer<typeof StartupReadinessRungIdSchemaZ>;

/** Canonical rung order. The ladder is always exactly this sequence. */
export const STARTUP_READINESS_RUNG_ORDER = [
  "daemon-spawned",
  "credential-held",
  "identity-established",
  "catalog-populated",
  "attachment-issuable",
] as const satisfies readonly StartupReadinessRungId[];

/**
 * Faults that no existing vocabulary names. Kept deliberately tiny: a code
 * belongs here ONLY when no contract already spells the same failure. Every
 * other stuck reason reuses the enum that owns it.
 */
export const StartupReadinessOwnReasonSchemaZ = z.enum([
  /** The daemon holds no owner capability, so privileged reads cannot be authorized. */
  "owner-capability-unavailable",
  /** No generation-stamped daemon identity could be established. */
  "daemon-identity-unavailable",
  /** The trusted tmux/pane discovery pass itself failed (no catalog to judge). */
  "catalog-discovery-failed",
  /**
   * Workspaces ARE registered, but none of their tmux sessions yielded a live
   * pane — the sessions died, or the tmux server they lived on is gone. This is
   * deliberately distinct from an empty fleet: nothing was expected there, while
   * here something was expected and is missing.
   */
  "catalog-sessions-unreachable",
  /** The attachment runtime never passed (or failed) its startup barrier. */
  "attachment-runtime-unready",
]);
export type StartupReadinessOwnReason = z.infer<typeof StartupReadinessOwnReasonSchemaZ>;

/**
 * A stuck reason, tagged with the vocabulary it was drawn from so a reader can
 * always tell which contract defines the code it is looking at.
 */
export const StartupReadinessStuckReasonSchemaZ = z.discriminatedUnion("vocabulary", [
  z
    .object({
      vocabulary: z.literal("desktop-daemon-host-issue"),
      code: DesktopDaemonHostIssueCodeSchemaZ,
    })
    .strict(),
  z
    .object({
      vocabulary: z.literal("terminal-resource-unavailable"),
      code: TerminalResourceUnavailableReasonSchemaZ,
    })
    .strict(),
  z
    .object({
      vocabulary: z.literal("terminal-attachment-issue"),
      code: TerminalAttachmentIssueErrorCodeSchemaZ,
    })
    .strict(),
  z
    .object({
      vocabulary: z.literal("startup-readiness"),
      code: StartupReadinessOwnReasonSchemaZ,
    })
    .strict(),
]);
export type StartupReadinessStuckReason = z.infer<typeof StartupReadinessStuckReasonSchemaZ>;

export type StartupReadinessStuckVocabulary = StartupReadinessStuckReason["vocabulary"];

/**
 * Which vocabularies may explain which rung. A `catalog-populated` rung can
 * never be blamed on a host-probe code, and a `daemon-spawned` rung can never
 * be blamed on a pane stamp — the schema enforces that rather than trusting
 * each producer to be careful.
 */
export const STARTUP_READINESS_RUNG_VOCABULARIES = {
  "daemon-spawned": ["desktop-daemon-host-issue"],
  "credential-held": ["startup-readiness"],
  "identity-established": ["desktop-daemon-host-issue", "startup-readiness"],
  "catalog-populated": ["terminal-resource-unavailable", "startup-readiness"],
  "attachment-issuable": ["terminal-attachment-issue", "startup-readiness"],
} as const satisfies Record<StartupReadinessRungId, readonly StartupReadinessStuckVocabulary[]>;

/**
 * How the semantic pane catalog was populated when `catalog-populated` is
 * satisfied. This is the honest empty-fleet distinction: `fleet: "empty"` means
 * the catalog was READ successfully and contains nothing — the user has no
 * adopted, app-registered sessions yet. That is a satisfied rung with zero
 * attachable panes, never a stuck one, and the surfaces above it are expected
 * to say "no sessions yet", not "something went wrong".
 */
export const StartupReadinessCatalogPopulationSchemaZ = z
  .object({
    fleet: z.enum(["empty", "populated"]),
    /** Registered workspaces the catalog pass considered. */
    workspaceCount: z.number().int().min(0).max(4_096),
    /** Panes that would resolve to an attachable target right now. */
    attachablePaneCount: z.number().int().min(0).max(4_096),
  })
  .strict()
  .superRefine((population, ctx) => {
    const empty = population.workspaceCount === 0;
    if (empty !== (population.fleet === "empty")) {
      ctx.addIssue({
        code: "custom",
        path: ["fleet"],
        message: "an empty fleet is exactly a catalog with no registered workspaces",
      });
    }
    if (empty && population.attachablePaneCount !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["attachablePaneCount"],
        message: "an empty fleet cannot contain attachable panes",
      });
    }
  });
export type StartupReadinessCatalogPopulation = z.infer<
  typeof StartupReadinessCatalogPopulationSchemaZ
>;

const RungBaseFields = {
  rung: StartupReadinessRungIdSchemaZ,
  /** When this rung was last evaluated against real state. */
  observedAt: z.iso.datetime({ offset: true }),
} as const;

export const StartupReadinessRungSchemaZ = z
  .discriminatedUnion("status", [
    z.object({ ...RungBaseFields, status: z.literal("pending") }).strict(),
    z
      .object({
        ...RungBaseFields,
        status: z.literal("satisfied"),
        /** Present only on a satisfied `catalog-populated` rung. */
        population: StartupReadinessCatalogPopulationSchemaZ.optional(),
      })
      .strict(),
    z
      .object({
        ...RungBaseFields,
        status: z.literal("stuck"),
        reason: StartupReadinessStuckReasonSchemaZ,
      })
      .strict(),
  ])
  .superRefine((rung, ctx) => {
    if (rung.status === "satisfied" && rung.population !== undefined) {
      if (rung.rung !== "catalog-populated") {
        ctx.addIssue({
          code: "custom",
          path: ["population"],
          message: "catalog population is only meaningful on the catalog-populated rung",
        });
      }
      return;
    }
    if (rung.status !== "stuck") return;
    const allowed: readonly StartupReadinessStuckVocabulary[] =
      STARTUP_READINESS_RUNG_VOCABULARIES[rung.rung];
    if (!allowed.includes(rung.reason.vocabulary)) {
      ctx.addIssue({
        code: "custom",
        path: ["reason", "vocabulary"],
        message: `${rung.rung} cannot be explained by the ${rung.reason.vocabulary} vocabulary`,
      });
    }
  });
export type StartupReadinessRung = z.infer<typeof StartupReadinessRungSchemaZ>;

export const StartupReadinessLadderSchemaZ = z
  .object({
    observedAt: z.iso.datetime({ offset: true }),
    rungs: z.array(StartupReadinessRungSchemaZ).length(STARTUP_READINESS_RUNG_ORDER.length),
    /**
     * The first rung that is not satisfied — the one thing blocking startup —
     * or `null` when the whole ladder is satisfied. Derived, but carried on the
     * wire so every reader agrees on it without re-deriving.
     */
    blockedAt: StartupReadinessRungIdSchemaZ.nullable(),
  })
  .strict()
  .superRefine((ladder, ctx) => {
    for (const [index, rung] of ladder.rungs.entries()) {
      const expected = STARTUP_READINESS_RUNG_ORDER[index];
      if (rung.rung !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["rungs", index, "rung"],
          message: `rung ${index} must be ${expected}`,
        });
      }
    }
    // Ladder discipline: nothing is satisfied above the blocking rung.
    const firstUnsatisfied = ladder.rungs.findIndex((rung) => rung.status !== "satisfied");
    if (firstUnsatisfied >= 0) {
      for (const rung of ladder.rungs.slice(firstUnsatisfied + 1)) {
        if (rung.status === "satisfied") {
          ctx.addIssue({
            code: "custom",
            path: ["rungs"],
            message: "a rung cannot be satisfied above an unsatisfied rung",
          });
          break;
        }
      }
      // Exactly one rung may be stuck: the blocking one. Everything above it is pending.
      for (const rung of ladder.rungs.slice(firstUnsatisfied + 1)) {
        if (rung.status === "stuck") {
          ctx.addIssue({
            code: "custom",
            path: ["rungs"],
            message: "only the blocking rung may be stuck",
          });
          break;
        }
      }
    }
    const expectedBlockedAt =
      firstUnsatisfied >= 0 ? STARTUP_READINESS_RUNG_ORDER[firstUnsatisfied]! : null;
    if (ladder.blockedAt !== expectedBlockedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["blockedAt"],
        message: "blockedAt must name the first unsatisfied rung",
      });
    }
  });
export type StartupReadinessLadder = z.infer<typeof StartupReadinessLadderSchemaZ>;

/** The daemon-served resource: a generation-stamped ladder, same shape idiom as every other resource. */
export const StartupReadinessResourceSchemaZ = z
  .object({
    version: z.literal(STARTUP_READINESS_RESOURCE_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    ladder: StartupReadinessLadderSchemaZ,
  })
  .strict();
export type StartupReadinessResource = z.infer<typeof StartupReadinessResourceSchemaZ>;

// ---------------------------------------------------------------------------
// Pure construction helpers
// ---------------------------------------------------------------------------

/**
 * Build a well-formed ladder from a partial verdict list. Callers describe only
 * what they PROVED, in order; this fills the rest in honestly — every rung
 * above a stuck or pending one becomes `pending`, and `blockedAt` is derived.
 * There is no way to hand-author an inconsistent ladder through this door.
 */
export function buildStartupReadinessLadder(
  verdicts: readonly (
    | { readonly status: "satisfied"; readonly population?: StartupReadinessCatalogPopulation }
    | { readonly status: "stuck"; readonly reason: StartupReadinessStuckReason }
  )[],
  observedAt: string,
): StartupReadinessLadder {
  const rungs: StartupReadinessRung[] = [];
  let blocked = false;
  for (const [index, rungId] of STARTUP_READINESS_RUNG_ORDER.entries()) {
    const verdict = blocked ? undefined : verdicts[index];
    if (verdict === undefined) {
      rungs.push({ rung: rungId, status: "pending", observedAt });
      blocked = true;
      continue;
    }
    if (verdict.status === "stuck") {
      rungs.push({ rung: rungId, status: "stuck", observedAt, reason: verdict.reason });
      blocked = true;
      continue;
    }
    rungs.push({
      rung: rungId,
      status: "satisfied",
      observedAt,
      ...(rungId === "catalog-populated" && verdict.population !== undefined
        ? { population: verdict.population }
        : {}),
    });
  }
  const firstUnsatisfied = rungs.findIndex((rung) => rung.status !== "satisfied");
  return {
    observedAt,
    rungs,
    blockedAt: firstUnsatisfied >= 0 ? STARTUP_READINESS_RUNG_ORDER[firstUnsatisfied]! : null,
  };
}

/** The rung blocking this ladder, with its reason when it is stuck rather than pending. */
export function startupReadinessBlockingRung(
  ladder: StartupReadinessLadder,
): StartupReadinessRung | null {
  return ladder.rungs.find((rung) => rung.status !== "satisfied") ?? null;
}

/**
 * The desktop's view of startup readiness, folded from what the shell already
 * knows plus (when reachable) the daemon's own ladder.
 *
 * This is why the ladder is worth having: when the daemon cannot be reached at
 * all, the renderer no longer shows a generic "connection failed" — it reports
 * `daemon-spawned` stuck with the host issue code that the supervisor observed,
 * and carries the daemon child's own last words alongside it.
 */
export const DesktopStartupReadinessSchemaZ = z
  .object({
    ladder: StartupReadinessLadderSchemaZ,
    /** Present when the blocked rung has the daemon child's captured output to show. */
    childOutput: DaemonChildOutputTailSchemaZ.optional(),
  })
  .strict();
export type DesktopStartupReadiness = z.infer<typeof DesktopStartupReadinessSchemaZ>;

export interface DesktopStartupReadinessInput {
  /** What the desktop host reports about the daemon right now. */
  readonly daemon: DesktopDaemonCapabilityState;
  /**
   * The daemon's own ladder, when it was reachable and readable.
   *
   * Optional on purpose: a disconnected capability state already CARRIES the
   * ladder the host read while composing it, and that is used when nothing is
   * passed here. The defect this replaces was a call site that passed `null`
   * and so silently threw the daemon's answer away.
   */
  readonly ladder?: StartupReadinessLadder | null;
  readonly observedAt: string;
}

/**
 * PURE. Fold the desktop's daemon state and the daemon-served ladder into one
 * ladder the renderer can render directly.
 *
 * - Daemon not connected and no ladder read → `daemon-spawned` is stuck with
 *   the host issue code, and the child output tail carried on that state
 *   travels with it.
 * - Daemon not connected but a ladder WAS read → the read is itself proof a
 *   daemon answered, so its own account of where startup stopped is preferred
 *   over the host's outside view. A ladder that clears every rung is the one
 *   exception: the daemon believes it is fine, so the host issue is the only
 *   true explanation of why this desktop still cannot use it.
 * - Connected but no ladder read → the three rungs the desktop itself proved
 *   (a daemon answered, with our credential, carrying an identity) are
 *   satisfied and the catalog rungs stay honestly pending.
 * - Connected with a ladder → the daemon's ladder is the answer.
 */
export function projectDesktopStartupReadiness(
  input: DesktopStartupReadinessInput,
): DesktopStartupReadiness {
  if (input.daemon.status !== "connected") {
    const childOutput: DaemonChildOutputTail | undefined = input.daemon.childOutput;
    const ladder = input.ladder ?? input.daemon.startupReadiness ?? null;
    if (ladder && ladder.blockedAt !== null) {
      return { ladder, ...(childOutput ? { childOutput } : {}) };
    }
    return {
      ladder: buildStartupReadinessLadder(
        [
          {
            status: "stuck",
            reason: { vocabulary: "desktop-daemon-host-issue", code: input.daemon.code },
          },
        ],
        input.observedAt,
      ),
      ...(childOutput ? { childOutput } : {}),
    };
  }
  if (input.ladder) return { ladder: input.ladder };
  // A connected host state is itself proof of the first three rungs: the probe
  // reached a daemon, it was authorized, and it returned a stamped identity.
  return {
    ladder: buildStartupReadinessLadder(
      [{ status: "satisfied" }, { status: "satisfied" }, { status: "satisfied" }],
      input.observedAt,
    ),
  };
}
