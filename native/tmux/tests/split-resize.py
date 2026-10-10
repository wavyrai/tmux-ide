#!/usr/bin/env python3
"""Private-server proof of exact ancestor resizing and rejection without mutation."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

binary = str(pathlib.Path(sys.argv[1]).resolve())
root = tempfile.mkdtemp(prefix="tmux-split-resize-", dir="/tmp")
socket = root + "/t.sock"
env = {k: v for k, v in os.environ.items()
       if not k.startswith("TMUX") and k not in ("HOME", "XDG_CONFIG_HOME")}
env.update(HOME=root, XDG_CONFIG_HOME=root, TERM="xterm-256color")
evidence = {"binary": binary, "sha256": hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest(),
            "cases": [], "cleanup": False}


def run(*args, ok=True):
    result = subprocess.run([binary, "-S", socket, "-f", "/dev/null", *args],
                            env=env, capture_output=True, text=True, timeout=8)
    if ok:
        assert result.returncode == 0, (args[0], result.stderr)
        return result.stdout.strip()
    assert result.returncode != 0, (args[0], "unexpected success")
    return result.stderr.strip()


def snapshot(window):
    return {
        "layout": run("display-message", "-p", "-t", window, "#{window_layout}"),
        "zoom": run("display-message", "-p", "-t", window, "#{window_zoomed_flag}"),
        "panes": {row[0]: row[1:] for row in (line.split("\t") for line in run(
            "list-panes", "-t", window, "-F",
            "#{pane_id}\t#{pane_birth_id}\t#{pane_pid}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}"
        ).splitlines())},
    }


def command(window, layout, path, axis, boundary):
    return ["tmux-ide-resize-split", "-s", session_id, "-t", window, "-E", layout,
            "-p", path, "-a", axis, "-c", str(boundary)]


def identities(state):
    return {key: value[:2] for key, value in state["panes"].items()}


def group_edge(state, group, axis):
    offset = 2 if axis == "cols" else 3
    return min(int(state["panes"][pane][offset]) for pane in group) - 1


try:
    run("new-session", "-d", "-s", "proof", "-x", "160", "-y", "160", "sleep 600")
    session_id = run("display-message", "-p", "-t", "proof:", "#{session_id}")
    assert session_id.startswith("$"), "missing session identity"
    evidence["sessionId"] = session_id
    evidence["capability"] = json.loads(run("tmux-ide-resize-split", "-V"))
    assert evidence["capability"]["capability"] == "split-resize-v1"
    assert evidence["capability"]["sessionMembership"] == "exact-session-link-v1"
    for axis in ("cols", "rows"):
        window = run("new-window", "-d", "-t", "proof", "-P", "-F", "#{window_id}", "sleep 600")
        run("set-option", "-w", "-t", window, "pane-border-status", "off")
        run("resize-window", "-t", window, "-x", "160", "-y", "160")
        left = run("list-panes", "-t", window, "-F", "#{pane_id}")
        main, cross = ("-h", "-v") if axis == "cols" else ("-v", "-h")

        def split(pane, direction):
            return run("split-window", "-d", direction, "-t", pane,
                       "-P", "-F", "#{pane_id}", "sleep 600")

        right = split(left, main)
        groups = []
        for top in (left, right):
            bottom = split(top, cross)
            groups.append([top, split(top, main), bottom, split(bottom, main)])
        before = snapshot(window)
        assert len(before["panes"]) == 8
        assert all(int(values[0]) > 0 and int(values[1]) > 0
                   for values in before["panes"].values()), "birth/PID evidence unavailable"
        original_edge = group_edge(before, groups[1], axis)
        receipt = json.loads(run(*command(window, before["layout"], "0", axis, original_edge + 3)))
        after = snapshot(window)
        assert group_edge(after, groups[1], axis) == original_edge + 3
        assert receipt["boundary"] == original_edge + 3 and receipt["layout"] == after["layout"]
        assert identities(before) == identities(after), "pane processes/birth identities changed"
        assert before["zoom"] == after["zoom"] == "0"

        # A stale drag must not restore or mutate a newer layout.
        error = run(*command(window, before["layout"], "0", axis, original_edge + 5), ok=False)
        assert snapshot(window) == after
        negatives = [
            ["tmux-ide-resize-split", *command(window, after["layout"], "0", axis, 90)[3:]],
            ["tmux-ide-resize-split", "-s", "$4294967295", *command(window, after["layout"], "0", axis, 90)[3:]],
            ["tmux-ide-resize-split", "-s", "proof", *command(window, after["layout"], "0", axis, 90)[3:]],
            command(window, after["layout"], "1", axis, 90),  # last child
            command(window, after["layout"], "0", "rows" if axis == "cols" else "cols", 90),
            command(window, after["layout"], "0.99", axis, 90),
            command(window, after["layout"], "0." , axis, 90),
            command(window, after["layout"], "0", axis, -1),
            command(window, after["layout"], "0", axis, 4097),
            command(window, after["layout"], "0", axis, "90suffix"),
            command(window, after["layout"], "0", axis, 90) + ["-V"],
            command(window, after["layout"], "0", axis, 90) + ["-c", "91"],
            command(window, "x" * 65537, "0", axis, 90),
        ]
        for args in negatives:
            run(*args, ok=False)
            assert snapshot(window) == after

        # Exact repeat is a no-op; reverse movement uses actual readback.
        repeated = json.loads(run(*command(window, after["layout"], "0", axis, original_edge + 3)))
        assert repeated == receipt and snapshot(window) == after
        reverse = json.loads(run(*command(window, after["layout"], "0", axis, original_edge)))
        restored = snapshot(window)
        assert reverse["boundary"] == original_edge
        assert group_edge(restored, groups[1], axis) == original_edge
        assert identities(restored) == identities(before)

        # Both directions move then saturate, preserving pane identities.
        clamped = []
        for requested in (0, 159):
            state = snapshot(window)
            result = json.loads(run(*command(window, state["layout"], "0", axis, requested)))
            actual = snapshot(window)
            assert result["layout"] == actual["layout"]
            assert result["boundary"] == group_edge(actual, groups[1], axis)
            assert 0 < result["boundary"] < 159
            prior_edge = group_edge(state, groups[1], axis)
            assert (result["boundary"] < prior_edge if requested == 0
                    else result["boundary"] > prior_edge)
            assert identities(actual) == identities(before)
            saturation = json.loads(run(*command(window, actual["layout"], "0", axis, requested)))
            assert saturation == result and snapshot(window) == actual
            clamped.append(result)

        run("resize-pane", "-Z", "-t", left)
        zoomed = snapshot(window)
        run(*command(window, zoomed["layout"], "0", axis, original_edge), ok=False)
        assert snapshot(window) == zoomed, "refusal must not unzoom"
        run("resize-pane", "-Z", "-t", left)
        unzoomed = snapshot(window)
        # Address a deeper split explicitly; its ancestor divider stays put.
        coordinate, size = (2, 4) if axis == "cols" else (3, 5)
        inner_edge = int(unzoomed["panes"][left][coordinate]) + int(unzoomed["panes"][left][size])
        inner = json.loads(run(*command(window, unzoomed["layout"], "0.0.0", axis, inner_edge - 1)))
        inner_after = snapshot(window)
        assert inner["boundary"] == inner_edge - 1
        assert group_edge(inner_after, groups[1], axis) == group_edge(unzoomed, groups[1], axis)
        assert identities(inner_after) == identities(before)
        # A structural replacement also invalidates the earlier expected tree.
        split(left, cross)
        changed = snapshot(window)
        run(*command(window, inner_after["layout"], "0", axis, original_edge), ok=False)
        assert snapshot(window) == changed
        evidence["cases"].append({"axis": axis, "before": before, "after": after,
                                  "receipt": receipt, "staleError": error,
                                  "negativeCases": len(negatives), "clamped": clamped,
                                  "zoomRefusalUnchanged": True, "innerReceipt": inner,
                                  "structuralChangeRejected": True})
        run("kill-window", "-t", window)
        # Original five-pane reproducer: resize the non-origin middle subtree.
        window = run("new-window", "-d", "-t", "proof", "-P", "-F", "#{window_id}", "sleep 600")
        run("set-option", "-w", "-t", window, "pane-border-status", "off")
        run("resize-window", "-t", window, "-x", "160", "-y", "160")
        first = run("list-panes", "-t", window, "-F", "#{pane_id}")
        middle = split(first, main)
        last = split(middle, main)
        split(middle, cross)
        split(middle, main)
        five_before = snapshot(window)
        edge = group_edge(five_before, [last], axis)
        five_receipt = json.loads(run(*command(window, five_before["layout"], "1", axis, edge + 3)))
        five_after = snapshot(window)
        assert five_receipt["boundary"] == edge + 3 == group_edge(five_after, [last], axis)
        assert five_after["panes"][first] == five_before["panes"][first]
        assert identities(five_after) == identities(five_before)
        evidence["cases"].append({"axis": axis, "kind": "non-origin-middle",
                                  "before": five_before, "after": five_after, "receipt": five_receipt})
        run("kill-window", "-t", window)
    # Both session and pane lifetime survive unlinking the window. Only the
    # synchronous membership check prevents mutation through the stale scope.
    window = run("new-window", "-d", "-n", "membership", "-t", "proof", "-P", "-F", "#{window_id}", "sleep 600")
    run("set-option", "-w", "-t", window, "window-size", "manual")
    run("resize-window", "-t", window, "-x", "160", "-y", "80")
    anchor = run("list-panes", "-t", window, "-F", "#{pane_id}")
    second = run("split-window", "-d", "-h", "-t", anchor, "-P", "-F", "#{pane_id}", "sleep 600")
    run("new-session", "-d", "-s", "elsewhere", "sleep 600")
    run("link-window", "-s", window, "-t", "elsewhere:9")
    linked = snapshot(window)
    edge = group_edge(linked, [second], "cols")
    # Shared membership is allowed by this low-level primitive. The daemon's
    # separate geometry-owner policy must decide whether to expose it.
    member_receipt = json.loads(run(*command(window, linked["layout"], "0", "cols", edge + 2)))
    member_after = snapshot(window)
    assert member_receipt["boundary"] == edge + 2
    assert identities(member_after) == identities(linked)
    run("unlink-window", "-t", "proof:membership")
    unlinked = snapshot(window)
    assert unlinked == member_after
    assert run("display-message", "-p", "-t", "proof:", "#{session_id}") == session_id
    run(*command(window, unlinked["layout"], "0", "cols", edge + 4), ok=False)
    assert snapshot(window) == unlinked
    # Re-link the same physical window and recover using a fresh layout read.
    run("link-window", "-s", window, "-t", "proof:99")
    recovered = json.loads(run(*command(window, snapshot(window)["layout"], "0", "cols", edge + 4)))
    assert recovered["boundary"] == edge + 4
    evidence["sessionMembership"] = {"linkedMutation": True, "unlinkedRefusalUnchanged": True,
                                     "sessionAndPaneIdentitiesSurvived": True, "relinkedRecovery": True}
    run("kill-window", "-t", window)
    run("kill-session", "-t", "=elsewhere")
    # Empty panes have no shell processes: exercise serializer admission without
    # spawning hundreds of children. The real current layout fits the serializer,
    # but its conservative resize bound must be rejected before any mutation.
    window = run("new-window", "-d", "-t", "proof", "-P", "-F", "#{window_id}", "sleep 600")
    run("set-option", "-w", "-t", window, "pane-border-status", "off")
    run("resize-window", "-t", window, "-x", "4096", "-y", "2")
    anchor = run("list-panes", "-t", window, "-F", "#{pane_id}")
    for _ in range(399):
        run("split-window", "-d", "-E", "-h", "-l", "1", "-t", anchor)
    large = snapshot(window)
    assert len(large["panes"]) == 400 and 0 < len(large["layout"]) < 8192
    run(*command(window, large["layout"], "0", "cols", 2000), ok=False)
    assert snapshot(window) == large
    evidence["serializerBudgetRefusal"] = {"panes": 400, "layoutBytes": len(large["layout"]),
                                            "unchanged": True}
    run("kill-window", "-t", window)
finally:
    # Exact owned socket only; cleanup failure must fail the fixture.
    try:
        run("kill-server")
        evidence["cleanup"] = True
    finally:
        shutil.rmtree(root)
        print(json.dumps(evidence, indent=2))
