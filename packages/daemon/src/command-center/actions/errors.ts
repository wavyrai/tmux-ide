/**
 * Typed errors for the v2 action dispatcher. Every error path through a
 * handler funnels into one of these so the dispatcher can map to the
 * `{ ok: false, error: { code, message, details? } }` envelope without
 * stringly-typed catches.
 *
 * Codes are stable wire identifiers — never rename without a coordinated
 * dashboard release. New codes go at the bottom of the union.
 */

import { TerminalCwdError, type TerminalCwdErrorReason } from "../../server/pty-bridge.ts";

export type ActionErrorCode =
  | "project_not_found"
  | "cwd_not_found"
  | "cwd_not_directory"
  | "cwd_stat_failed"
  | "session_already_running"
  | "session_not_running"
  | "launch_failed"
  | "stop_failed"
  | "terminal_not_found"
  | "validation_failed"
  | "task_not_found"
  | "goal_not_found"
  | "milestone_not_found"
  | "mission_not_set"
  | "task_dependency_unmet"
  | "task_already_assigned"
  | "skill_invalid"
  | "skill_not_found"
  | "ide_yml_missing"
  | "config_missing"
  | "config_path_invalid"
  | "config_validation_failed"
  | "legacy_config_mutation_unsupported"
  | "workspace_write_failed"
  | "config_exists"
  | "validation_assertion_not_found"
  | "webhook_not_found"
  | "webhook_test_failed"
  | "remote_access_restart_failed"
  | "shutdown_already_in_progress"
  | "daemon_instance_mismatch"
  | "bad_request"
  | "thread_not_found"
  | "permission_request_not_found"
  | "workspace_not_found"
  | "workspace_unavailable"
  | "harness_not_allowed"
  | "harness_unavailable"
  | "mission_not_found"
  | "operation_conflict"
  | "operation_capacity"
  | "pane_creation_failed"
  | "pane_cleanup_unproven"
  | "pane_resource_changed"
  | "internal";

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  readonly details: unknown | undefined;

  constructor(args: {
    code: ActionErrorCode;
    message: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(
      args.message,
      args.cause !== undefined ? { cause: args.cause as Error | undefined } : undefined,
    );
    this.name = "ActionError";
    this.code = args.code;
    this.details = args.details;
  }

  toEnvelope(): {
    code: ActionErrorCode;
    message: string;
    details?: unknown;
  } {
    return this.details !== undefined
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

const CWD_REASON_TO_CODE: Record<TerminalCwdErrorReason, ActionErrorCode> = {
  notFound: "cwd_not_found",
  notDirectory: "cwd_not_directory",
  statFailed: "cwd_stat_failed",
};

/**
 * Translate a {@link TerminalCwdError} into an {@link ActionError} with the
 * matching wire code. The cwd is preserved in `details` so the dashboard can
 * surface it without re-parsing the error message.
 */
export function actionErrorFromCwdError(err: TerminalCwdError): ActionError {
  return new ActionError({
    code: CWD_REASON_TO_CODE[err.reason],
    message: err.message,
    details: { cwd: err.cwd, reason: err.reason },
    cause: err,
  });
}

/**
 * Wrap an unknown thrown value as an `internal` ActionError. Used as the
 * last-resort branch in dispatcher catch blocks so handlers never leak raw
 * Error stacks across the wire.
 */
export function wrapInternalError(err: unknown): ActionError {
  if (err instanceof ActionError) return err;
  if (err instanceof TerminalCwdError) return actionErrorFromCwdError(err);
  const message = err instanceof Error ? err.message : String(err);
  return new ActionError({ code: "internal", message, cause: err });
}
