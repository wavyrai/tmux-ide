/**
 * @tmux-ide/daemon-client — discover + ensure a running daemon.
 *
 * Three layers, all pure functions:
 *   - lock.ts   : atomic read/write/clear of ~/.tmux-ide/daemon.lock
 *   - health.ts : two-stage liveness check (kill -0 + GET /healthz)
 *   - ensure.ts : ensureDaemon() — read lock, probe, spawn if absent/stale
 *
 * Consumer wiring (CLI / dashboard / electron) lives outside this package
 * — see T068 for that work.
 */

export * from "./lock.ts";
export * from "./health.ts";
export * from "./ensure.ts";
