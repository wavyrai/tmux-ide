# Default Linux ARM64 requalification after other containers stopped

Three sequential bounded runs passed after the user stopped nine Supabase containers. Dockerps was empty before/after each and showed only its exact owned fixture during execution. DockerVMtotal remained1010122752bytes; no settings, restart, service or network changes were made. No NODE_OPTIONS heap override. Prior OOM/timeouts and constrainedheap diagnostic remain preserved under nr01-current-payload/nr01-heap-diagnostic evidence.

All used cachedimage051c5eff12767eb13f4288d36112233b099e2925739b6612591a50e6af630653, LinuxARM64, Node24.21.0, stocktmux3.8,2CPU/768MiB/256PIDs, networknone and no hostmounts. Exact commands, terminalDockerinspect, before/after hashes, cgroup memory events/peak/current/max and VMmeminfo are retained per run.

| Lane | Session | Container runtime including setup | Memory peak bytes | Outcome |
|---|---:|---:|---:|---|
| Exact frozen873ef58e overlay/CLI/bridge |29584|8.63s|731746304|pass|
| Current tracked overlay +09e7bd45 packagedbrowser cad69 + fresh Linux CLI |31909|8.54s|627494912|pass|
| Current tracked source browser, actual CI discovery command |96247|10.34s|759566336|pass|

These durations are diagnostic wallclock, not benchmark samples. All max/oom/oom_kill counters0 and OOMKilledfalse; sock_throttled454/471/450 retained. Memory headroom is limited, particularly sourcecase; a single pass does not qualify arbitrary concurrency/capacity. Stoppedcontainers are the observed environment change, not proof of solecause for priorOOM or a productfix.

Current overlay source.json records exact tracked fileSHA/HEAD; untracked/ignoredsource excluded. Package/lock/workspace/buildpolicy unchanged since873ef58e; only package delta is remote incompatible guidance in fleet-connection-status.ts. Fresh supported CLIbuild inside disposablecontainer produces EXACTprior d4252e328292012da246bc086833c3720b0e55365e50e5da86826a4f2c31b1f5; metafile excludes that module, establishing no CLIruntime drift. No hostgeneratedbin touched. Copiedout CLI remains ignored, no binary duplicated here.

Packagedcase uses current09browser cad69a1026c6263c1561cb977dac2600359d7bf0db9ca58423cf993c3c05e7d8/livea128; build60s separate from smoke90s deadline. Sourcecase explicitly unsets cachedimage bundle/CLI/runtime env, sets TMUX_GPUI_TEST_DISCOVERY=1 and runs `.github/workflows/gpui-preview.yml` browsercommand `node --import tsx apps/tmux-gpui/bridge/browser-smoke.mjs`. Defaultfixture builds /work/bin/cli.js only insidecontainer. Sourcecase180s deadline(+10escalation) was authorized before launch; later90preference arrived afterlaunch, so it was not changed midrun. It completed10.34s, but timeoutpolicy differs and is recorded. All commandpaths prove switching/requestorder/unavailability, resizeburst, backgroundinput rejection, foregroundrecovery and fresh95x30grid/input through existing smoke assertions.

Every ownedcontainer was inspected terminal then removed; Dockerps empty afterward and protectedCLI/payload hashes stable. No production sessions/daemons or GUI touched. This closes the bounded local default LinuxARM64 sourcebrowser and packagedbrowser checks; not hostedLinuxx64, fullCI/alljourneys, otherplatforms, nativeGUI/signing or overallrelease acceptance.

Retained run.py files depend on original ignored `.tasks/native-reliability-mission/nr01-*-idle-requalification` paths and cachedimage/payload prerequisites; auditcopies are not location-independent. Use new exclusive output namespaces when reproducing; never overwrite these receipts. No dependencyinstall/imagebuild/pull occurs. Frozen original tar and currentoverlay are not duplicated; hashes/manifests retained. No further runs implicit.
