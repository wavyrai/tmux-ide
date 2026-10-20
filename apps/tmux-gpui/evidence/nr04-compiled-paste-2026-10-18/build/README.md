# Current paste-fix compiled/runtime artifacts

Source is exact git archive e0f813bd8b687f5d193bfccfe1a96b94bdc3fe37. Isolated source git metadata points at that existing commit via alternates (no new commit). Build-only workspace links resolve to archived packages; map retained. Third-party build dependencies reuse local installed versions: not hermetic.

Pinned Bun normal build-tui produced clean-source standalone baseline macOS arm64 TUI; build-tui.log includes source provenance. Normal npm pack/prepack built CLI from same archive and preserved package metadata. Normal private global install preserved exact CLI and manifest bytes. npm file list excludes TUI, so runtime stays separate in source/packages/daemon/dist/tui; nothing inserted into installed package. Original receipt failure is a harness expectation of bundled TUI, not a failed compiler/pack/install.

Initial npm11 install blocked three lifecycle scripts. After inspection, explicit private-prefix npm rebuild with --allow-scripts=tmux-ide,@parcel/watcher,node-pty ran known lifecycle scripts, with no global npm configuration writes. Node24 loads both native dependency modules. Hashes for installedCLI/manifest, compiledTUI and protected checkoutCLI unchanged; private canonical/state daemon records absent. See lifecycle-receipt.json and logs. This is preparation for separate compiled TUI + installed daemon qualification, not proof of normal end-user installer or released binary behavior.

Recipe: parent directory build-package.py, then rebuild-private.py. No publication, signing, production launch, main checkout dependency changes or generatedCLI edits. Artifacts retained for isolated runtime qualification.
