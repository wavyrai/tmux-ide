# NR07 first local session — 2026-10-18

Reviewed local implementation; NR07 remains open. No merge or release claim.

## Proven gap and owner
Previous evidence at ../nr07-local-setup-2026-10-18/empty-named-before.json proves a daemon can start on a cold unique named socket, yet GPUI Home rejects the empty server inventory. Explicit absent socket paths are a different fail-closed identity case; those checks remain unchanged.

The bridge now proves a current local daemon and zero online servers before advertising an opaque first-session action. Submission consumes that action, revalidates owner/currentness, and makes one existing workspace.session.create owner call. No retry, fabricated scope or direct tmux mutation is added to the application. The receipt must match operation and daemon identity. A private scoped catalog is admitted only after original-owner revalidation and exact workspace/live identity reconciliation. The created session is then available to open normally.

Native Home uses the existing dialog with a distinct local-daemon target. The protocol rejects a capability mixed with terminal or server authority. Request, presence, composition, queue and token checks apply; revoked targets close stale dialogs. Passive appearance of an online local server revokes the first-session offer.

## Actual source journey
`first-session-third.json`: qualified Node24.21, source browser and private copied CLI (hash recorded), stock tmux3.8, fresh HOME/state/registry and unique named socket, no initial daemon or server. Setup is explicit; duplicate setup converges to one observed identity. Background/foreground replaces the creation token; submitting the old token does not add a user session. Duplicate current-token submission yields exactly one user session plus the daemon-owned internal chrome helper. The created session opens through scoped discovery; live input becomes ready; a marker submitted via paste/Enter appears as its own line in tmux capture. Exact owned daemon and server cleanup passes; stderr empty.

`external-server-pass.json` separately starts an owned ordinary tmux server while the first-session offer is visible. Passive discovery revokes the offer; the old token cannot add another user session. Explicit Refresh discovers that one existing session, which opens and accepts the input marker. Cleanup passes.

`bundled-bridge-pass.json` repeats the full setup/create/open/input journey with a standalone bridge built by scripts/build-bridge.mjs, with no node_modules in the private working directory. Exact bundle hashes are in bridge-files.json. The copied CLI still uses source externals, so this is not full installed-package qualification.

These receipts do not prove native GUI or signed packaged qualification. Source children require a node_modules symlink in the private fixture cwd for tsx. No personal daemon, session, setting or default socket is used.

## Retained failed attempts
`first-session-first.json`: incorrect harness assertion counted the expected _tmux-ide-chrome helper as a second user session. Corrected by excluding that exact internal session name, while retaining one-user-session assertion.
`first-session-second.json`: source child could not resolve tsx from the private cwd; terminal never became ready. The fixture now explicitly supplies source dependencies. `source-child-resolution.json` independently reproduces ERR_MODULE_NOT_FOUND without the cwd dependency link and successful tsx import with it. This is not a packaged runtime fix.

## Checks and remaining acceptance
Affected bridge suite:38 passed. Native focused tests:4 local_session and8 new_session passed before a mechanical test-module extraction. ESLint/typecheck and formatting pass. Full Rust gates passed: default 3095 passed/11 ignored; all-features 3129 passed/18 ignored; zero failures. Both clippy configurations, formatting and file-size checks passed; independent source review found no remaining blocker after catalog-publication and passive-revocation fixes.

Still required: actual native GUI dialog-to-input, packaged installer/first launch, second supported Mac, missing tools and SSH onboarding, plus remaining mission gates. Mac locked during this slice. No signing, push, merge or publication performed.
