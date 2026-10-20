# Linux resource diagnosis and bundled-bridge qualification

The stalled source-mode run cannot establish a tmux input defect. A subsequent diagnostic run at the same source (4c45fa9f), limits and tmux3.8 recorded memory.events oom_kill=1 and Docker State.OOMKilled=true. Docker's VM has1GiB total and also runs unrelated services. No production services or Docker settings were changed. The retained observer wait-for process is normal idle behavior; it did not prove a cleanup deadlock.

Using the existing release bridge bundler and TMUX_GPUI_TEST_BUNDLE avoids runtime TypeScript loader processes in the browser/helper. This is a supported packaged-bridge path, not a simulated substitute. The first same browser-smoke journey then passed with OOMKilled=false and oom_kill=0, including input on the second session, twenty-resize burst, foreground restoration, stale input rejection and cleanup. No performance claim is made: source and bundled processes have different overhead.

Recipe and complete logs remain at .tasks/nr02-linux. The local image derives from tracked source4c45fa9f, with the same lockfile as its existing dependency layer. Stock tmux3.8 tarball SHA256:e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e. The bundle is built by apps/tmux-gpui/scripts/build-bridge.mjs, then used via TMUX_GPUI_TEST_BUNDLE=/work/.tasks/linux-bridge. Inherited TMUX_IDE_RUNTIME_MODE is unset for the isolated fixture. Test runs have no host volumes/network,2CPUs,768MiB and256PID limits, and90second outer timeout. Containers are removed only after terminal state is inspected and saved.

This qualifies a bounded Linux ARM64 bundled-bridge journey. It does not qualify source-mode CI under adequate memory, Linuxx64, native macOS input, the whole NR01 matrix or the release. Keep those requirements open.

Four consecutive bundled runs passed (exit0, OOMKilled=false, oom_kill=0); repeated-run states and commands are retained in bundle-repeats.json. This is not a latency target or proof of visually seamless switching.
