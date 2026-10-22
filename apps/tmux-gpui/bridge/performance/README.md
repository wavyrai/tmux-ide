# Owned GUI/TUI visible-response qualification

This opt-in harness observes the exact fixture marker text (Vision OCR) **and**
its unique color in screenshots of one owned application window. It never calls
helper JSON arrival, an input ACK, or a tmux capture a visible response. Screenshot
capture gives an observation interval, not a display-vsync timestamp: report the
lower/upper bound and uncertainty, not a fabricated sub-frame point estimate.

It creates its own HOME, tmux socket, daemon, three panes, GUI launcher and a new
Ghostty application instance. It only targets recorded child PIDs and their
windows. Personal Terminal/Ghostty/TmuxIDE windows and sessions are not used.
SSH mode creates its own localhost sshd, ephemeral keys, and SSH forwards; this
is SSH transport coverage, **not** a remote-host/network-latency claim. TUI uses
its public `app SESSION --server ID --ssh ALIAS` entry and production SSH relay;
GUI uses the supported host config over its private SSH forward. Record that
transport implementation difference when interpreting results.

## Prepare, without running samples

Use Node24 and put the desired bundled tmux on PATH. Use an already-built CLI,
matching compiled TUI and matching native app; explicitly declare `--profile debug`
or `--profile release` (recorded as caller-declared, not inferred). There are no implicit builds or
downloads. Compile the small macOS probe outside the repository:

```sh
swiftc apps/tmux-gpui/bridge/performance/window-probe.swift -o /tmp/tmux-gui-window-probe
/tmp/tmux-gui-window-probe preflight
node --test apps/tmux-gpui/bridge/performance/measurement.test.mjs
```

The probe checks Screen Recording and event-posting access without prompting.
Output-trigger mode requires capture; physical-input mode requires both. When a
required permission is unavailable, the harness stops before launching fixtures. It does
not silently substitute a renderer/helper endpoint. Preflight in this session
reported capture available and input posting unavailable. Enabling posting is
an OS permission action; do not assume successful capture grants it.

## Run only after builds are quiet

```sh
node --import tsx apps/tmux-gpui/bridge/performance/visible-response.mjs \
  --cli /absolute/matching/bin/cli.js \
  --tui /absolute/matching/tmux-ide-tui \
  --app /absolute/matching/TmuxIDE.app \
  --probe /tmp/tmux-gui-window-probe \
  --output /absolute/new/evidence-directory \
  --route local --trigger output --profile release --run yes
```

Repeat with a fresh output directory and `--route ssh`. Each run is bounded to
five minutes including setup/arming and contains five GUI/TUI pairs in AB/BA
order. Do not run the two routes concurrently. The output directory must not
already exist and is created private. Its parent must exist.

The fixture launches clients, then waits for explicit arming. Read its
`ui-state.json` to identify only the owned windows. Select the named session and
first pane in the native GUI; TUI launches that session through the public CLI.
Resize the owned windows until each gives the same canonical tmux window and
all three pane grids. Use the fixture's exact socket from ui-state when reading
geometry. Do not resize production windows to calibrate this experiment.

Write `armed.json` in that evidence directory:

```json
{ "guiPid": 123, "guiWindow": 456, "tuiWindow": 789, "cols": 110, "rows": 32 }
```

IDs must come from this fixture's inventory. The harness verifies ownership
again on every capture/input. It activates only those instances, checks matched
window/pane grids before every trial, sends a unique marker followed by Enter,
and requires exactly those bytes once in the intended pane. In `--trigger output`
mode, private tmux sends the marker directly to the owned program; this bypasses
client input and measures the daemon/output/render path. `--trigger physical`
uses PID-targeted OS keyboard events and is currently blocked by event-posting
permission. No permission prompt is requested. A sample completes
only after both marker OCR and color are observed in the owned window screenshot.
Failures and timeouts stay in the receipt; incomplete work is not counted as fast.

`receipt.json` records exact build hashes, route, terminal version, tmux version,
CPU-load snapshots, configured Menlo14 font, per-window display refresh/scale
(where the OS reports them), marker witnesses, screenshots, per-sample intervals and
five-sample median/range of the conservative upper bounds. Native executable,
live/browser bundles, bridge manifest, embedded Node, launcher, CLI and TUI
hashes identify the exact artifacts. Unknown or differing display metadata is
marked explicitly and prevents a fully matched comparison claim. It also checks pane
PIDs survive closing both clients before disposing the private daemon/socket.
Input logs are synthetic fixture data, not user terminal contents. Intended-pane
and PID witnesses are persisted before marker setup so failures retain them.

## Limits and remaining instrumentation

This harness measures source-trigger→visible output, or (when explicitly selected
and permitted) physical key→visible echo through real GUI/TUI windows. These
endpoints are separately named in receipts and must not be pooled. Output-trigger
measurements do not establish client typing latency. The trigger timestamps
bracket private tmux command execution, so upper bounds conservatively include
that invocation overhead on both sides.
Pane-switch, divider and whole-window resize correctness already have separate
owned/native fixtures; they are not silently included in this timing claim.
Screen-capture command startup/OCR sampling limits precision. OCR runs after the
capture end timestamp and does not inflate that timestamp, but can increase the
gap before the next observation. Differences smaller than observed interval
uncertainty are inconclusive.

For finer renderer-only timing, an opt-in native observer should identify the
exact marker frame **after** `TerminalPainter.paint_frame`, and pair it with
TUI's existing `terminal-input-to-paint` sink. Neither JSON decode nor assigning
`painted_frame` proves completed paint. Use one calibrated clock or record each
process clock explicitly. Such instrumentation is not implemented here and
would still not prove display-vsync timing.
