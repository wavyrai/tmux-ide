import { createHash } from "node:crypto";
// Explicit allowlist: never serialize catalog contents, routes, tokens, or errors.
export function catalogObservation(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.sessions)) return null;
  const event = {
    type: "catalog-publication",
    sessionCount: Math.min(value.sessions.length, 513),
    paneCount: Array.isArray(value.panes) ? Math.min(value.panes.length, 513) : 0,
    selectedSession: typeof value.selectedSession === "string",
    selectedPane: typeof value.selectedPane === "string",
    preferredPane: typeof value.preferredPane === "string",
    sessionCatalogComplete: value.sessionCatalogComplete === true,
    inputReady: value.inputReady === true,
    status: [
      "Loading sessions",
      "Choose a session",
      "No live sessions",
      "Connecting native terminal",
    ].includes(value.status)
      ? value.status
      : "other",
    homePhase: ["loading", "live", "unavailable"].includes(value.home?.phase)
      ? value.home.phase
      : "other",
    surface: ["home", "workspace"].includes(value.surface) ? value.surface : "other",
  };
  for (const key of ["request", "sequence", "presenceRevision"])
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) event[key] = value[key];
  return event;
}

// Owned fixture diagnostics: compare publications without retaining layout contents.
export function nativeCatalogObservation(value) {
  if (value?.type !== "native-terminal-catalog" || !Array.isArray(value.layouts)) return null;
  const encoded = JSON.stringify(value.layouts);
  if (encoded.length > 1024 * 1024) return null;
  return {
    layoutDigest: createHash("sha256").update(encoded).digest("hex"),
    layoutBytes: Buffer.byteLength(encoded),
    layoutCount: value.layouts.length,
  };
}
