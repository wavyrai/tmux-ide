# Selected-server tmux diagnostic metadata

Additive optional GET `/api/v1/tmux-servers/:serverId/:generation/diagnostics`; existing strict payloads unchanged. Owner bearer/no-store inherited. Canonical owner reads actual `#{version}` through generation-fenced runner, checks abort/retirement; registry checks owner before and after await. Default embedded owner also implements the read. Unknown version syntax fails optional metadata only; no terminal compatibility policy changed.

Client `readTmuxServerDiagnostics` performs one bounded authenticated GET (4096 bytes, existing timeout), exact response scope and bounded version validation;404 returns null, other failures throw for optional caller handling. No retry/discovery/startup. Bridge/native integration belongs to another owner.

Checks:4 route tests,16 client tests (including existing client suite),1 actual-server test, daemon TypeScript noEmit, changed-file ESLint and diffcheck passed. Initial TypeScript failure revealed the default embedded owner implementation was also required; retained failed log and passing rerun. Two initial Bun commands used incorrect working-directory/filter and matched no files; corrected package-local invocation passed.

Actual test used stocktmux3.8 through private temp socket/state and a wrapper whose executable -V says99.9. The owner returned selected-server version, refused aborted read, refused old identity after replacing only that private socket's server, and refused read after disposal. Finally disposed owner, killed only that private socket server, checked list-sessions fails and removed temp root. This is socket teardown verification, not a retained per-PID process inventory. No generated CLI build, production daemon/session, native GUI or release action.

Commands: package daemon `pnpm exec vitest run src/command-center/tmux-server-diagnostics.test.ts`; package daemon-client `bun test ./src/tmux-server-diagnostics.test.ts ./src/tmux-server-client.test.ts`; package daemon with PATH prefixed by worktree `.tasks/tmux38-compat/tmux-3.8`, `pnpm exec vitest run --config vitest.live.config.ts src/lib/tmux-server-diagnostics-live.test.ts`; daemon `pnpm exec tsc --noEmit`. Live owner session79650 and route/typecheck68919 both exited0. Raw logs alongside.

Independent reviewer np01_review approved source and retained evidence. Base964b0138. Local increment only; bridge/native integration and release remain pending.
