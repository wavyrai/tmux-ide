# Contextual fleet connection guidance

Bounded NR05/NR06/NR08 slice based on cc114621. The bridge projects only canonical FleetConnectionStatus phase/failure codes. Home displays fixed guidance for non-ready machines, including SSH authentication, host verification, missing CLI/daemon and incompatibility. No error text, credentials, paths, retry counters or timestamps enter the new metadata.

Catalog readiness and opaque retry/disconnect capabilities remain authoritative. A ready transport with an unavailable catalog does not become a ready machine. Identity conflicts take priority; each complete publication replaces diagnostic metadata, and ready groups suppress stale failure guidance. No new action or reconnect policy is introduced.

## Compatibility

New native accepts old publications with no diagnostic field. Old native rejects additional fields: this change must ship as a paired native executable and bridge bundle. It is not independent backward compatibility.

## Verification

- Focused bridge tests: 25 passed (fleet-diagnostic.test.ts and fleet.test.ts). Full bridge gate with Node 24.21.0: 557 passed, zero failed, five skipped; TypeScript check passed. A first run accidentally used Node 26.10.0 and failed three exact-stderr assertions on its loader deprecation warning. Both logs are retained; assertions were not weakened.
- Independent source review found no blocker for the paired candidate.
- Native focused tests passed: 397 passed, zero failed, one ignored. Initial module-path compile failures were corrected and retained in .tasks/nr05-quiet-status/fleet-diagnostics-tests*.log. A duplicate waiting cargo process was stopped. Full workspace gates passed against stable source: default 3077 passed/11 ignored; all features 3111 passed/18 ignored; zero failures. All-feature and no-default-feature clippy, formatting and file-size checks passed. Changed bridge ESLint/Prettier also passed.
- Physical narrow/light/dark guidance rendering and keyboard actions remain unverified while the Mac is locked.

This does not complete NR05/NR06/NR08. Terminal-specific contextual state, bounded diagnostic export, user setup actions, SSH recovery and full native acceptance remain separate work. Nothing newly merged or published.
