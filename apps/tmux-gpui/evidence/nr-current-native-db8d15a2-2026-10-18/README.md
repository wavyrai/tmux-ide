# Current local native candidate

Built from db8d15a2 using the repository local native build wrapper, cached/offline Rust1.96.1 and external target directory. Native source snapshot/hash and binary identity are recorded in build-summary.json; full receipt remains at the stated private path. Protected bin/cli.js was not rebuilt. No source changes occurred during the build.

Initial check-packaged-app.sh built successfully but assembly failed because cargo was absent from the inherited PATH for Rust notices generation. That failure is retained in assembly.log. Retried assemble-local-app.mjs against the SAME binary and native receipt into a new destination, with explicit toolchain PATH, CARGO_HOME=/private/tmp/tmux-gpui-toolchain/cargo and RUSTUP_HOME=/Users/thijs/.rustup. Assembly passed. No rebuild, dependency change or skipped notices.

Node24 package checks local-app.test.mjs, compatibility-process.test.mjs, machine-remove-process.test.mjs and fleet-refresh-diagnostic.test.mjs then passed all10 tests, exit0. These cover bundle identity/launcher isolation, unsupported daemon refresh, route guidance and mutation fencing. They do not prove live terminal/native GUI journeys or full release qualification.

Local unsigned app: .tasks/native-reliability-mission/current-native-db8d15a2/Tmux IDE Current QA.app. Not opened or installed into production; no signing/publication. Physical checks remain pending because native control last reported the Mac locked. Existing user previews/sessions remain untouched. Previous partial assembly is retained separately as failure evidence.
