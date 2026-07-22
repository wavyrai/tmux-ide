/**
 * Wire codes for the v2 action dispatcher's error envelope. Codes are
 * stable identifiers — never rename without a coordinated dashboard
 * release. New codes go at the bottom of the union.
 *
 * The runtime class that throws these (`ActionError`, `TerminalCwdError`,
 * etc.) lives in @tmux-ide/daemon's command-center/actions/errors.ts; the
 * type lives here so dashboards and other UI clients can branch on the
 * code without reaching into daemon-internal modules.
 */
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
  | "workspace_conflict"
  | "session_conflict"
  | "workspace_creation_failed"
  | "workspace_cleanup_unproven"
  | "workspace_resource_changed"
  | "internal";
