# Pane-switch input interruption diagnostic

Local diagnostic derived from unsigned candidate 0.1.2 build2026101501. This is instrumented runtime evidence, not release qualification or a performance benchmark. The candidate itself is unchanged. The opt-in patch was independently reviewed, compiled, copied to a uniquely identified private QA app, and reversed from source before execution.

## Trigger and observation

In the isolated two-pane native app, click the other pane and immediately type `echo GPUI_LEFT_OK` followed by Return. The first attempt displays Input interrupted and does not execute. Click the now-ready pane and retype: the left marker executes only in the left pane.

The retained trace establishes:

- Sequence 43: selection increments the request and clears frame/readiness, with interruption latch false.
- Sequences 47–49: input arrives before readiness; rejection changes the latch to true.
- Sequence 102: matching ready publication retains the interruption latch.
- Sequences 121–125: clicking the ready selected pane rearms input; subsequent input is accepted.

The right pane subsequently accepted its marker after one selection click and a separate UI observation roundtrip, without a second click. That contrast is not readiness-traced because logging had reached its 128-event cap. A fresh-process matching-readiness contrast remains unverified.

## Outcome and limits

Harness session 47060 exited 0 after Cmd-Q. Both target markers remained separate and survived app close. The owned fixture root was absent afterward. Only disposable sessions, daemon, socket, HOME and QA window were used. User previews and production sessions were untouched.

Independent reviewer np01_review confirmed the mechanism and limited conclusions. The interruption guard prevents a dropped command prefix from leaving an executable suffix. This run does not establish a product fix, seamless switching, general latency, or a reason to weaken that guard. Synchronous instrumentation may perturb timing. No product code changed.

The diagnostic binary remaining in target/debug must not be packaged as a release. Original raw run artifacts remain in .tasks/native-input-gate-trace-20261016.

## Fresh-process readiness contrast

A second isolated run (session 19899, exit 0) clicked the left pane once (sequence 40), queued selection (41), then waited until a matching request-3 ready publication was observed (53/54) before typing. Input decisions from 59 accepted with latch false, without another click or rearm. Both marker targets passed and survived app close; the owned root was absent afterward. This confirms that the reproduced early-input interruption is avoidable by waiting for readiness in this run, not that switching is seamless or has bounded latency. The trace still caps at 128 records.

The requested screenshot returned old pane labels from an earlier run, so it is excluded from this contrast's visual evidence. Runtime trace and harness output are the acceptance evidence here. No product code was changed.
