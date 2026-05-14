# Incident: daemon stops listening but keeps running (port 6060 dead, process alive)

## Symptom

Multiple daemon processes for the same session stay alive (`pgrep -fl daemon.ts`
shows 2+ instances), none have a TCP socket open (`lsof -p <pid>` shows zero
TCP/IPv entries), and `curl :6060` returns connect-refused. The daemon log only
ever contains the single startup banner `[daemon] Command Center on
http://127.0.0.1:6060 (session: new-name)` — no crash, no stack trace, no exit
code. `.tasks/events.log` shows historical `daemon-watchdog` entries
(`Daemon exited with code null, respawning in 1000ms`) but the watchdog is not
currently running, so the respawn chain is no longer at play here.

## Likely root cause

`handle.stop()` in `packages/daemon/src/lib/daemon-embed.ts` shuts down the
HTTP server, clears intervals, drops PTY bridges, and closes WS clients — but
it never calls `process.exit()`. The only path that exits after stop is the
SIGTERM/SIGINT handler in `packages/daemon/src/lib/daemon.ts` (`shutdown()` →
`process.exit(0)`).

Every other code path that invokes `handle.stop()` therefore leaves a "ghost"
daemon process behind:

1. **`takeover` from a second daemon launch.** When a new daemon starts and
   `readCanonicalDaemonInfo()` shows a live canonical daemon, the new daemon
   calls `requestDaemonShutdown()` which POSTs `/api/v2/action/daemon.shutdown`
   to the existing one (`daemon-embed.ts:414`). That hits
   `daemonShutdownHandler` → `setDaemonShutdownBackend` → `handle.stop()`. The
   server closes, the canonical file is cleared (`clearCanonicalDaemonInfo()`
   in the `finally`), but the original process keeps its event loop alive on
   leftover unref-pending tasks (task-store WAL flush, async work in flight,
   etc.) and never exits. The new daemon then succeeds in binding 6060.
   Repeated takeovers accumulate ghosts.
2. **`tick()` in `daemon-embed.ts:819` calls `stopSelf?.()`** (== `handle.stop()`)
   when `!sessionExists(sessionName)`. Same shape: stop without exit.
3. **`setRemoteAccessRestartBackend`** calls `handle.stop()` then restarts an
   embedded daemon in-process. The previous server is gone; if the new
   `startEmbeddedDaemon` throws, the old listener is not restored.

The schema-validation spam from `.tasks/tasks/098-f3-fix-or-delete-2d-test-fixtures-...json`
(`proof.tests.total: Invalid input: expected number, received undefined`) is
loud but does NOT crash anything — `TaskStoreValidationError` is thrown out
of `parseContent` and re-caught by callers; reconcile keeps spinning every
30s and re-logs each time. Worth fixing separately (write `proof.tests.total`
or drop `proof.tests` on that task), but it's a red herring for the listener
death.

## Why the user-visible "daemon keeps dying" pattern

It does not "die". The first daemon to bind 6060 keeps running until something
(takeover from a second start, a tick miss on `sessionExists`, a remote-access
toggle, or an explicit `/api/v2/action/daemon.shutdown`) calls `handle.stop()`.
At that instant the HTTP listener disappears but the Node process survives.
The next launcher reads stale canonical info, finds the port reachable as
"down" (`isCanonicalDaemonAlive` returns false because /health 500s after
stop), wipes the canonical file, binds 6060, logs the same banner, and joins
the pile. Both processes show up under `pgrep`; neither is reachable.

## Suggested fix (not applied here — `packages/daemon/src/lib/` is in scope

but the right call between options needs sign-off)

Pick one:

- Have `setDaemonShutdownBackend(async () => { await handle.stop(...);
process.exit(0); })` so the takeover action actually terminates the
  process, matching the SIGTERM contract.
- Or, on `handle.stop()` completion, unref every remaining handle and let the
  event loop drain naturally, and have `daemon.ts`'s `main()` `await`
  shutdown via a deferred promise that the handle resolves on stop, then
  `process.exit(0)` from `main()`.
- Or, register an internal `stopSelf` that exits after stop in the daemon
  entrypoint, and route every non-signal stop through it.

The takeover path (`requestDaemonShutdown` + canonical file polling) explicitly
expects the existing process to go away — `takeoverCanonicalDaemon` will
SIGTERM/SIGKILL by PID after 10s if it's still alive — so option 1 also keeps
the takeover loop's deadline at ~0s instead of 10s in the common case.

## Confirming evidence

- Two daemons alive simultaneously, no socket on either:
  `pgrep -fl 'daemon.ts new-name'` returned PIDs 40513 and 45185 (different
  start times, ~1h apart). `lsof -p 40513` and `lsof -p 45185` showed zero
  TCP descriptors. `nc -zv 127.0.0.1 6060` → connection refused.
- Single boot banner in `/tmp/daemon.log` per process, no error after.
- `daemon-embed.ts` `handle.stop` (line 868) does not call `process.exit`.
- `daemon.ts` only exits on SIGTERM/SIGINT or on `startEmbeddedDaemon` throwing.
- `requestDaemonShutdown` is wired to `setDaemonShutdownBackend` via
  `daemonShutdownHandler` → backend → `handle.stop`.

No code changes in this commit — just the post-mortem note.
