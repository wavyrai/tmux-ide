# Explicit compiled TUI + installed daemon paste qualification — verified

Executed after artifact-owner readiness confirmation. npm2.9.7 installed package does not itself include packages/daemon/dist/tui; qualification will therefore name the separately built archived-source compiled TUI plus installed package daemon. This is not public installer or public CLI entry qualification.

Existing scripts/tui-testdrive.mjs:90 accepts TMUX_IDE_TESTDRIVE_TUI_BIN; omitting --source selects compiled mode and invokes target with app --target. The helper hardcodes checkout TMUX_IDE_CLI at1574. Harness avoids that reference reaching the compiled runtime using an owned0700 wrapper: exports exact installedCLI path then execs exact compiledTUI with unchanged arguments. Testdrive targets wrapper via existing TUI_BIN override. Generated launcher and wrapper retained; no sharedhelper/product edits needed. Private daemon is prestarted through startDaemon({cliPath: exact installedCLI}), so no bundlebuild. InstalledCLI/package identity and compiledbinary canonical file/executable validated before private setup; hashes checked again after cleanup.

Run only once artifacts are ready, from isolated worktree with Node24:
```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/packaged-paste-harness/run.mjs /absolute/installed/tmux-ide/bin/cli.js /absolute/archived/packages/daemon/dist/tui/tmux-ide-tui
# same command plus off for DEC2004-off
```

Output directories tui and tui-off are exclusive. Same independent rawreceiver/oracle as retained Unicode matrix: exact2150framed bytes modeon or2138unframed modeoff; real combining/wide/emoji across chunk boundary and3newlines. Actual testdrive paste enters hosted compiled TUI parser. Receiver never evaluates payload; enabled/disabled mode observed from source before paste. Exact final bytes reread after finalmarker plus geometry, originalidentity unchanged132x41window/132x40content, allcaptured ownedPIDs exit, protected checkoutCLI unchanged. Final claims distinguish actual compiledTUI frame from sourceGPUIbridge (not run here). Before running, retain build/package provenance separately; an arbitrary compiledbinary hash alone does not prove builtfromcurrentfix.

## Results

Modeon session91524 and modeoff97066 exited0. Exact receiver2150/2138bytes respectively; final reread, compiledTUI finalmarker, geometry/identity and observedPIDcleanup all pass. Runtime/CLI hashes unchanged, protected checkoutCLI unchanged. Exact installedCLI SHA9f6c49a1155558be0689f8cea2bb433bbfc7c3eccf090827c3a3c0f0515c0366; compiledTUI SHA0204da65810321f673ae3ed1038e59d2a8d1eebe90b90d17b87a20540f17c1f2.

Build provenance copied as build-artifact-provenance.json and build-lifecycle-receipt.json; original build-receipt.json intentionally preserves failed assumption that npm package includedTUI. Archive source e0f813bd; separatelycompiledruntime+installeddaemon with nonhermetic reused thirdparty dependencies. Private npm11 allowlisted lifecycle rebuild and native dependencyload succeeded before run. No installedpublicTUI/installer/signing/release qualification inferred.
