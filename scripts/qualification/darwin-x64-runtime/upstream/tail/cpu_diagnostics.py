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


def _ps_seconds(value):
    days, value = value.split("-", 1) if "-" in value else ("0", value)
    parts = value.split(":")
    if len(parts) not in (2, 3):
        raise ValueError("Invalid ps CPU time")
    seconds = sum(float(part) * 60 ** index for index, part in enumerate(reversed(parts)))
    return int(days) * 86400 + seconds


def descendant_snapshot(pid):
    """Live-only readiness sample. Exited bootstrap helpers are NOT represented."""
    pending, seen, rows = [pid], set(), []
    while pending:
        parent = pending.pop()
        result = subprocess.run(["pgrep", "-P", str(parent)], text=True, capture_output=True, timeout=5)
        if result.returncode not in (0, 1):
            raise RuntimeError("Could not enumerate readiness descendants")
        for raw in result.stdout.split():
            child = int(raw)
            if child in seen:
                continue
            seen.add(child)
            if len(seen) > 32:
                raise RuntimeError("Unexpected readiness process tree")
            sample = subprocess.run(["ps", "-o", "pid=,ppid=,time=,comm=", "-p", str(child)],
                                    text=True, capture_output=True, timeout=5)
            if sample.returncode != 0 or not sample.stdout.strip():
                rows.append({"pid": child, "parent_pid": parent, "exited_before_sample": True})
                continue
            fields = sample.stdout.strip().split(None, 3)
            rows.append({"pid": int(fields[0]), "parent_pid": int(fields[1]),
                         "cpu_seconds_ps": _ps_seconds(fields[2]),
                         "executable": fields[3], "resolution_seconds": .01})
            pending.append(child)
    return {"coverage": "live-descendants-only; excludes already-exited helpers",
            "processes": rows}
