# Maintained native split bundle — 2026-10-10

The reviewed split-resize patch is now the fourth development-provenance patch.
The existing build recipe produced a private darwin-arm64 bundle from the pinned
tmux commit, with relocated libraries, licenses and terminfo. No installed binary,
production daemon, shipped dist directory or live user session was replaced.

`result.json` records exact commands, binary hash, exits and cleanup. The native
split correctness matrix, cross-session membership rejection and guarded runner
all passed against this fresh bundle. All 2,904 manifest file hashes were checked.
The parent reviewed the two-file source promotion and verified its recorded
hashes against the working tree. `identity.json` also records the raw build log
hash; that verbose compiler log remains at its temporary path.

This is development source promotion and macOS ARM64 validation only. Other three
native platforms and exact-candidate terminal release gates remain outstanding.
Daemon lazy activation, full packaged GPUI physical qualification and signed
preview publication remain separate requirements.
