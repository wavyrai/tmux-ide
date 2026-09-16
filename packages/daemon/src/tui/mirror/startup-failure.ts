import { WorkspacePromotionFailureCodeSchemaZ } from "@tmux-ide/contracts";
import { ApplicationShellTransportError } from "@tmux-ide/daemon-client/application-shell-session";

const reasons = new Set([
  "daemon-unavailable",
  "routing-unavailable",
  "daemon-generation-changed",
  "session-unavailable",
  "promotion-rejected",
  "promotion-unconfirmed",
  "connection-unavailable",
  "invalid_tmux_output",
  "invalid_tmux_pane_inventory",
  "admission_queue_full",
  "session_vanished_before_stamp",
  "empty_or_foreign_pane_inventory",
  "project_directory_unavailable",
  "inventory_changed_during_proof",
  "session_vanished_during_proof",
  "missing_window_stamp",
  "semantic_pane_catalog_rejected_inventory",
  "inconsistent_tmux_topology",
  "registry_mapping_missing",
  "unexpected_failure",
  "authority_disposed",
]);
const codes = new Set<string>([
  ...WorkspacePromotionFailureCodeSchemaZ.options,
  "workspace_unavailable",
  "bad_request",
  "unauthorized",
  "forbidden",
  "descriptor-invalid",
  "daemon-identity-mismatch",
  "not-found",
  "network-error",
  "http-error",
  "schema-invalid",
]);
export interface StartupFailure {
  readonly reason: string;
  readonly code?: string;
  readonly operationId?: string;
  readonly daemonGeneration?: string;
  readonly tuiGeneration?: string;
}
/** Only fixed vocabulary and bounded opaque IDs cross the UI/log boundary. */
export function safeStartupFailure(value: Readonly<Record<string, unknown>>): StartupFailure {
  const correlation: { daemonGeneration?: string; tuiGeneration?: string } = {};
  if (
    typeof value.daemonGeneration === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.daemonGeneration)
  )
    correlation.daemonGeneration = value.daemonGeneration;
  if (typeof value.tuiGeneration === "string" && /^build-[a-f0-9-]{36}$/.test(value.tuiGeneration))
    correlation.tuiGeneration = value.tuiGeneration;
  return Object.freeze({
    ...correlation,
    reason:
      typeof value.reason === "string" && reasons.has(value.reason)
        ? value.reason
        : "connection-unavailable",
    ...(typeof value.code === "string" && codes.has(value.code) ? { code: value.code } : {}),
    ...(typeof value.operationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.operationId)
      ? { operationId: value.operationId }
      : {}),
  });
}
export class OpenTuiStartupError extends Error {
  readonly failure: StartupFailure;
  constructor(value: Readonly<Record<string, unknown>>) {
    const failure = safeStartupFailure(value);
    super(`Session startup failed: ${failure.code ?? failure.reason}`);
    this.name = "OpenTuiStartupError";
    this.failure = failure;
  }
}
export function startupFailureFromError(error: unknown): StartupFailure {
  if (error instanceof OpenTuiStartupError) return safeStartupFailure({ ...error.failure });
  if (error instanceof ApplicationShellTransportError)
    return safeStartupFailure({ reason: "connection-unavailable", code: error.kind });
  return safeStartupFailure({});
}
