# Current native package at 09e7bd45

Owned gate70437 exited0: current native release build, unsigned local assembly and all10 package tests passed through check-packaged-app.sh. App: .tasks/native-reliability-mission/current-native-09e7bd45-final/Tmux IDE CI.app. Native binary/source/build identity and full receipt hash are in build-summary.json; original full native-build.json remains at its recorded private path. No source or HEAD changed while Cargo ran.

The candidate includes retained-snapshot serialization and version-repair guidance. This gate exercises package identity/compatibility, fixed launcher environment, machine mutation admission and fleet diagnostics. It does not exercise native painting, mouse/keyboard/scrolling, real SSH, fresh customer install, signing, notarization or second-Mac acceptance. Those remain separate gates. No user preview or production daemon/session was touched; no signing/publication.

First wrapper attempt rejected caller RUSTC override before building. That failure is retained; the successful rerun removed the override, allowing the supported wrapper to resolve and bind its own compiler. Separate output directories preserve both attempts. Committed log copies only trim redundant trailing newlines; originals remain unchanged.
