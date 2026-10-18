# NR07 missing agent refusal audit

Two isolated executable probes, Node24 + tsx, no real network or production state:
- probe.mts calls actual client createPane with injected HTTP409 harness_unavailable. Client throws request-failed/status409 and discards structured cause.
- route.mts calls actual bearer-authenticated Hono pane/create route with injected owner throwing actual WorkspacePaneCreationError(harness_unavailable). Response503 server-unavailable. One owner call. This proves loss at route and client, not actual absent executable detection.

Source live.ts new-agent catch converts errors to actionFailed; publication says Pane action unavailable — reselect pane to retry. browser accepts only that exact string. Thus actionable missing-tool acceptance is not implemented by existing generic error behavior. Need strict allowlisted refusal metadata at owner route/client and bounded guidance naming selected tool/machine without paths, secrets or untrusted raw text. Preserve uncertainty for other mutation failures; don't imply no mutation from generic503. Never retry automatically.

Next actual runtime proof: private environment with selected harness absent, verify no pane creation, helpful guidance, shell session still usable; installed-harness positive control. Coordinate live/browser edits after immediate history handoff owner completes.

Route-only correction implemented after failing regression (1 failed,2 passed): preserve actual WorkspacePaneCreationError(harness_unavailable) as409 with fixed code only. Unknown and potentially mutated failure remains503; authorization unchanged. Independent reviewer approved. Final explicitly scoped route suite18passed, ESLint clean. Initial multi-file Vitest filter also picked retained source copies under.tasks and failed3 import suites despite78tests passing; rerun excludes.tasks and is authoritative. No client/UI guidance fix yet. Native Cargo concurrently active so commit deliberately deferred.

Client transport follow-up: createPane alone opts into a1024-byte strict409 refusal parser. TmuxServerClientError retains generic request-failed/status plus optional fixed refusalCode; no raw context/message and no retries.13client tests pass including malformed/unknown/oversized/context-bearing errors; final daemon TypeScript and lint pass. First Bun invocation omitted ./ explicit paths and matched no tests; corrected invocation is authoritative. Independent review approved route and client. GPUI guidance and actual absent-tool runtime remain unfinished; no nativeGUI claim.
