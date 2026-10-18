# Quiet browser resource instrumentation pilot

One baseline/candidate pair passed all existing frozen-workload identity, target,
fresh-input, hash and cleanup checks. Both endpoint source captures remained
unchanged across the observation; this is not continuous repaint monitoring.
No producer was executed. The same A/B/A switches completed within the quiet clock.

| Pilot | Samples | Actual clock duration | Resource interval bounds | Browser CPU delta | Quiet-window sampled RSS maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline |124|10,001.62 ms|10,001.65–10,004.94 ms|0.67 s|358,272 KiB|
| Candidate |123|10,001.25 ms|10,001.28–10,004.15 ms|0.60 s|403,472 KiB|

Resource interval bounds reflect unknown counter read position within each ps
call, not statistical confidence. CPU counters display0.01s precision, which is
not accuracy; no interpolation to an exact10s interval. Whole observed lifecycle
RSSmaximum was358,272/408,768 KiB, distinct from the quiet-window maximum above.
These pilots validate instrumentation only, not a CPU saving or memory regression.
They must be excluded from any later five-pair comparison. No quiet-versus-busy
comparison or native/total-app resource claim is supported.

`validate-pilot.py` checks stable browser identity, monotonically increasing CPU,
nonoverlapping samples, command/ready containment, clock overrun and unchanged
endpoint captures; it regenerates `pilot-summary.json`. Sample-to-sample start
intervals and queue/call gaps remain explicit. Baseline40744 and candidate34445
both exited0; no failed attempt or retry, and no product/build changes.
