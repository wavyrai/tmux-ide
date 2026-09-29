"""Additional diagnostic counters; never used by the unchanged gate total."""
import math
import subprocess


def cpu_seconds(value):
    if not isinstance(value, dict) or set(value) != {"user", "system"}:
        raise ValueError("Invalid process.cpuUsage shape")
    for number in value.values():
        if isinstance(number, bool) or not isinstance(number, int) or number < 0:
            raise ValueError("CPU microseconds must be nonnegative integers")
    return (value["user"] + value["system"]) / 1_000_000


def readiness_diagnostics(ready, stopped, wait4_total, ready_elapsed, descendants):
    first, last = cpu_seconds(ready["cpu"]), cpu_seconds(stopped["cpu"])
    if last < first:
        raise ValueError("CPU counters decreased")
    if not math.isfinite(wait4_total) or wait4_total < 0:
        raise ValueError("Invalid final wait4 accounting")
    return {
        "reader_pid": ready.get("pid"),
        "ready_report": dict(ready["cpu"]),
        "stop_report": dict(stopped["cpu"]),
        "reader_self_cpu_at_ready_seconds": first,
        "reader_self_cpu_at_stop_report_seconds": last,
        "reader_self_cpu_after_ready_reported_seconds": last - first,
        "spawn_to_ready_wall_seconds": ready_elapsed,
        "live_descendants_at_ready": descendants,
        "final_wait4_cpu_including_startup_and_reaped_descendants_seconds": wait4_total,
        # This is NOT steady-state CPU: includes helpers' entire lifetime plus
        # reader shutdown tail. Do not subtract this or readiness from gate totals.
        "wait4_minus_ready_self_seconds": wait4_total - first,
        "wait4_minus_stop_self_seconds": wait4_total - last,
    }


def descendant_snapshot(pid):
    from linux_process import snapshot
    return snapshot(int(pid))
