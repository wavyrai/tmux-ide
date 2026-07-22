import { z } from "zod";

/**
 * The renderer-visible surface of the packaged-app auto-updater.
 *
 * The renderer NEVER sees a feed URL, a download URL, a filesystem path, a
 * checksum, or a signature. It receives only a coarse lifecycle phase plus the
 * two version strings it needs to render a single quiet "restart to apply" chip.
 * Everything that could be abused as a capability — where bytes come from, where
 * they land, and how they are trusted — stays in Electron main.
 *
 * Phase meaning:
 * - `idle`        — nothing to do; the last check found no newer release (or none yet).
 * - `checking`    — a channel feed check is in flight.
 * - `downloading` — a newer release was found; its artifact is being fetched + verified.
 * - `ready`       — a verified update is staged and will apply on the next launch.
 * - `applying`    — the staged update is being swapped in during quit.
 *
 * `ready` is sticky for the lifetime of the session: once an update is staged we
 * stop checking and simply wait for the user to restart. Any failure (offline,
 * corrupt download, malformed manifest, signature/checksum mismatch, downgrade)
 * fails closed back to `idle` — the current version keeps running, silently.
 */
export const DesktopUpdatePhaseSchemaZ = z.enum([
  "idle",
  "checking",
  "downloading",
  "ready",
  "applying",
]);

export type DesktopUpdatePhase = z.infer<typeof DesktopUpdatePhaseSchemaZ>;

/** The complete renderer-safe update status. No URLs, paths, or trust material. */
export const DesktopUpdateStatusSchemaZ = z
  .object({
    phase: DesktopUpdatePhaseSchemaZ,
    /** The running version — always known. */
    currentVersion: z.string().min(1),
    /**
     * The newer version being downloaded or staged, or null when there is
     * nothing pending. Present from `downloading` through `applying`.
     */
    availableVersion: z.string().min(1).nullable(),
  })
  .strict();

export type DesktopUpdateStatus = z.infer<typeof DesktopUpdateStatusSchemaZ>;
