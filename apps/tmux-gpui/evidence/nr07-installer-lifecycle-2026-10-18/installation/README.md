# Installer lifecycle policy qualification

Fresh private HOME/prefix from genuine current2.9.7 tarball fa8cf7edaa79aeb0425204556da662d162d66c7d93149a2945a7a0b02448b756 (source e0f813bd). Executed Node24/npm11 install --global --prefix PRIVATE --ignore-scripts, then only installed scripts/postinstall.js with npm_config_global=false. No third-party lifecycle rebuild or allow-scripts setting. This matches the audited installer lifecycle policy, not the complete download/checksum/runtime installation journey.

Native node-pty and @parcel/watcher imports succeeded under Node24; CLI reports2.9.7. InstalledCLI and manifest bytes unchanged after ownpostinstall. Private canonical/state/defaultHOME daemon records absent. Protectedcheckout CLI unchanged. Artifact retained for runner's actualTUI byte qualification; no server started in this setup slice. Full commands/environment overrides and hashes are in receipt.json. Package lives in sibling private-w5f4o2hz/installed/lib/node_modules/tmux-ide. This npm package excludes compiledTUI; later smoke pairs separately archived compiledTUI and labels that accurately.

Recipe copy qualify.py creates a new private installation when executed from worktree root. It uses explicit retained local tarball/Node dependencies.
