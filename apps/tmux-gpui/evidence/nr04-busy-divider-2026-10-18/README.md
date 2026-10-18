# NR04 finite active-output divider comparison — 2026-10-18

At source HEAD5b92f4f4, plain tmux, actual source OpenTUI and source GPUI bridge pass the same stock tmux3.8 geometry sequence while a finite producer is active: left66→69→75→66, right65→62→56→65, source window132×41, content height40/top1. Daemon lanes use genuine installed CLI2.9.7; clients remain source, not installed native applications.

All lanes copy exactly the same producer.sh into their private fixture. It repaints left-pane row8 with200 sequential ticks separated by nominal50ms sleeps, then emits DONE on row9. Right pane stays quiet. Producer startup uses direct tmux fixture input; later fresh input is delivered through each tested client. Same hash: b7a22be828914370e1b35dd079a0b16a06a69ec6abfd27d963de32176c118617.

Each geometry operation is bracketed by increasing source tick observations below200 with DONE absent. Plain stages observe1→2,2→3,3→4; actual TUI complete mouse drags observe1→6,7→13,14→21; GPUI advertised token gestures observe1→3,4→6,6→8. These differing intervals are not a speed comparison. GPUI verifies width69 before release and settled75 before a new restore gesture. All lanes preserve original per-lane IDs/shell PIDs and stable peer marker content.

After producer completion, canonical source tick200/DONE is checked; actual TUI framebuffer and GPUI published grid also contain final output. Fresh client input then reaches the source pane. Plain/TUI/GPUI verify3/6/6 captured owned PIDs exited, protected CLI unchanged and no cleanup errors. Transient sleep children are not individually tracked; successful finite producer completion and fresh shell input are separate proof. No production sessions/settings were used.

Root and independent reviewer checked identical producer hashes, exact shape fields, final pass/cleanup/protected flags and empty remaining PID lists. Per-lane source harnesses, receipts and captures are retained; artifact-sha256.json binds files. No failures occurred in this slice.

## Scope and reproduction

This proves one finite active-output horizontal divider case, not delivered20Hz, exact timing, every intermediate output frame, throughput stress, simultaneous busy panes, arbitrary terminal bytes/modes, nested/vertical layouts or physical native GPUI rendering. Plain uses direct resize-pane commands with explicit matching top-header policy; TUI uses complete mouse-protocol drags; GPUI exercises its continuous advertised bridge gesture. No performance improvement is claimed.

Per-lane READMEs identify the existing local toolchain. Retained scripts can run from the worktree root and write ignored nr04-busy artifacts; restore the retained producer.sh to .tasks/native-reliability-mission/nr04-busy/producer.sh first. Plain uses the recorded Node executable with plain-busy.mjs; source clients additionally use --import tsx. Dependencies are local retained artifacts, not portable CI setup. Broader NR04 and native/second-Mac/release gates remain open. No product code, merge, signing or publication changed.
