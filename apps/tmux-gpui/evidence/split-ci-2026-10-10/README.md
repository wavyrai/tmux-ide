# Maintained native split CI gate — 10 October 2026

The bundled-tmux release matrix now runs native split mutation/rejection,
unlink membership, guarded execution, retained owner activation and source
bridge gesture checks against each job's exact bundled binary. Sequential
checks use private sockets/HOME, pipefail, a 15-minute step deadline and
separate logs retained by the existing always-run artifact uploader.

All five exact fixture commands passed locally on macOS ARM64 against the
maintained bundle. Command receipts and binary hashes are retained here.
YAML parsing and diff checking passed. Independent review approved workflow
SHA-256 `a6b4ab14fba0478227b5f11118ba96a0c8c34e841966a53aaaacc518a9098825`.

This local result does not establish hosted CI or the other three platforms.
The bridge leg is explicitly source-level; exact packaged bridge checks are
separately recorded in committed-package-2026-10-10. No native GUI, publishing,
production session, or user demo action was performed.
