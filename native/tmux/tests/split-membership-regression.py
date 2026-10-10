#!/usr/bin/env python3
"""Fails on the pre-membership prototype; exact private-server unlink race."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

binary = str(pathlib.Path(sys.argv[1]).resolve())
root = tempfile.mkdtemp(prefix="tmux-split-membership-", dir="/tmp")
env = {key: value for key, value in os.environ.items() if not key.startswith("TMUX")}
env.update(HOME=root, XDG_CONFIG_HOME=root, TERM="xterm-256color")
evidence = {"sha256": hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest(), "cleanup": False}


def call(*args):
    return subprocess.run([binary, "-S", root + "/t.sock", "-f", "/dev/null", *args],
                          env=env, capture_output=True, text=True, timeout=5)


def run(*args):
    result = call(*args)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


try:
    run("new-session", "-d", "-s", "origin", "sleep 120")
    session_id = run("display-message", "-p", "-t", "origin", "#{session_id}")
    window = run("new-window", "-d", "-n", "moving", "-t", "origin", "-P", "-F", "#{window_id}", "sleep 120")
    run("set-option", "-w", "-t", window, "window-size", "manual")
    run("resize-window", "-t", window, "-x", "160", "-y", "80")
    run("split-window", "-d", "-h", "-t", window, "sleep 120")
    run("new-session", "-d", "-s", "destination", "sleep 120")
    run("link-window", "-s", window, "-t", "destination:9")
    layout = run("display-message", "-p", "-t", window, "#{window_layout}")
    identities = run("list-panes", "-t", window, "-F", "#{pane_id}:#{pane_birth_id}:#{pane_pid}")
    cap = json.loads(run("tmux-ide-resize-split", "-V"))
    assert cap["capability"] == "split-resize-v1"
    run("unlink-window", "-t", "origin:moving")
    assert run("display-message", "-p", "-t", window, "#{window_layout}") == layout
    assert run("display-message", "-p", "-t", "origin", "#{session_id}") == session_id
    assert run("list-panes", "-t", window, "-F", "#{pane_id}:#{pane_birth_id}:#{pane_pid}") == identities
    # Same native operation on both builds; old prototype has no session flag.
    scope = ["-s", session_id] if cap.get("sessionMembership") == "exact-session-link-v1" else []
    result = call("tmux-ide-resize-split", *scope, "-t", window, "-E", layout,
                  "-p", "0", "-a", "cols", "-c", "83")
    after = run("display-message", "-p", "-t", window, "#{window_layout}")
    evidence.update(before=layout, after=after, commandExit=result.returncode,
                    sessionAndPaneLifetimesUnchanged=True, capability=cap)
    assert result.returncode != 0 and after == layout, "resize escaped its selected session"
finally:
    try:
        run("kill-server")
        evidence["cleanup"] = True
    finally:
        shutil.rmtree(root)
        print(json.dumps(evidence, indent=2))
