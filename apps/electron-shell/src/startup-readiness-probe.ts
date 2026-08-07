/**
 * Reads the daemon's own startup readiness ladder for the desktop host.
 *
 * The renderer never talks to the daemon in production, so the ladder the
 * daemon computes at `GET /api/resources/startup-readiness` can only reach a
 * screen if the shell fetches it. This is that fetch, and it exists for one
 * case in particular: a daemon that ANSWERS while the desktop still cannot use
 * it. Then the daemon's ladder is the only account of where startup stopped —
 * the `credential-held` and `attachment-issuable` rungs, and the difference
 * between an empty fleet and an unreachable one, exist nowhere else.
 *
 * Every failure mode ends in `null`. This is diagnostics: it may never delay,
 * fail, or change a connection verdict, so the request is time-bounded, its
 * response is size-bounded, and anything unexpected is simply not reported.
 */
import { StartupReadinessResourceSchemaZ, type StartupReadinessLadder } from "@tmux-ide/contracts";

import {
  canonicalDaemonUrl,
  inspectCanonicalDaemonInfo,
} from "../../../packages/daemon/src/canonical.ts";

/** The ladder is a diagnostic; it never gets to hold up a connection verdict. */
export const STARTUP_READINESS_PROBE_TIMEOUT_MS = 2_000;
const STARTUP_READINESS_MAX_BYTES = 64 * 1024;

export interface StartupReadinessProbeOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly inspectCanonical?: typeof inspectCanonicalDaemonInfo;
  readonly timeoutMs?: number;
}

async function readBoundedText(response: Response): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > STARTUP_READINESS_MAX_BYTES) return null;
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim();
  if (mediaType?.toLowerCase() !== "application/json") return null;
  const body = await response.text();
  return body.length > STARTUP_READINESS_MAX_BYTES ? null : body;
}

/**
 * Fetch the ladder from the canonical daemon record, or answer null.
 *
 * The record is read fresh on every call: this runs precisely when the desktop
 * has decided the daemon is not usable, so nothing about a previous generation
 * can be assumed. The owner token in the record is the only capability that can
 * read the resource, and it never leaves the main process.
 */
export async function readDaemonStartupReadinessLadder(
  options: StartupReadinessProbeOptions = {},
): Promise<StartupReadinessLadder | null> {
  const inspect = options.inspectCanonical ?? inspectCanonicalDaemonInfo;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? STARTUP_READINESS_PROBE_TIMEOUT_MS;

  let url: string;
  let authToken: string | null;
  try {
    const record = inspect();
    if (record.status !== "valid") return null;
    url = canonicalDaemonUrl(
      "http",
      record.info.bindHostname,
      record.info.port,
      "/api/resources/startup-readiness",
    );
    authToken = record.info.authToken ?? null;
  } catch {
    return null;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: abort.signal,
      headers: {
        Accept: "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    });
    if (!response.ok) return null;
    const body = await readBoundedText(response);
    if (body === null) return null;
    const parsed = StartupReadinessResourceSchemaZ.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.ladder : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
