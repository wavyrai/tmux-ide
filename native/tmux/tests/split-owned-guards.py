#!/usr/bin/env python3
"""Qualify split primitive composition with the existing native lifetime wrapper."""
import hashlib
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid

binary = str(pathlib.Path(sys.argv[1]).resolve())
root = tempfile.mkdtemp(prefix="tmux-split-owned-", dir="/tmp")
env = {k: v for k, v in os.environ.items() if not k.startswith("TMUX")}
env.update(HOME=root, XDG_CONFIG_HOME=root, TERM="xterm-256color")
evidence = {"binarySha256": hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest(),
            "cases": [], "cleanup": False}


def call(*args):
    return subprocess.run([binary, "-S", root + "/t.sock", "-f", "/dev/null", *args],
                          env=env, capture_output=True, text=True, timeout=8)


def run(*args):
    result = call(*args)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def layout():
    return run("display-message", "-p", "-t", window, "#{window_layout}")


def resize(expected, boundary):
    return shlex.join(["tmux-ide-resize-split", "-s", session_id, "-t", window,
                       "-E", expected, "-p", "0", "-a", "cols", "-c", str(boundary)])


def guarded(body, **overrides):
    values = dict(epoch=cap["serverEpoch"], pane=pane, birth=birth,
                  name="proof", session=session_id, created=created)
    values.update(overrides)
    operation = str(uuid.uuid4())
    result = call("tmux-ide-run", "-I", "-E", values["epoch"], "-t", values["pane"],
                  "-B", values["birth"], "-s", values["name"], "-S", values["session"],
                  "-C", values["created"], "-O", operation, body)
    return operation, result


try:
    run("new-session", "-d", "-s", "proof", "-x", "160", "-y", "80", "sleep 120")
    session_id, created, window, pane, birth = run(
        "display-message", "-p", "-t", "proof:",
        "#{session_id}\t#{session_created}\t#{window_id}\t#{pane_id}\t#{pane_birth_id}"
    ).split("\t")
    run("split-window", "-d", "-h", "-t", pane, "sleep 120")
    cap = json.loads(run("tmux-ide-events", "-e"))
    original = layout()
    for name, override in [
        ("stale epoch", {"epoch": str(uuid.uuid4())}),
        ("wrong pane birth", {"birth": str(int(birth) + 1)}),
        ("wrong session creation", {"created": str(int(created) + 1)}),
        ("wrong session ID", {"session": "$4294967295"}),
    ]:
        _, result = guarded(resize(original, 83), **override)
        assert result.returncode != 0 and not result.stdout.strip(), (name, result.stdout)
        assert layout() == original, name
        evidence["cases"].append({"case": name, "refusedBeforeAcknowledgement": True,
                                  "layoutUnchanged": True})
    operation, result = guarded(resize(original, 83))
    assert result.returncode == 0, result.stderr
    acknowledgement, receipt = [json.loads(line) for line in result.stdout.splitlines()]
    assert acknowledgement["type"] == "operation-identity"
    assert acknowledgement["operationId"] == operation
    assert acknowledgement["serverEpoch"] == cap["serverEpoch"]
    assert int(acknowledgement["connectionId"]) > 0
    assert receipt["boundary"] == 83 and receipt["layout"] == layout() != original
    records = json.loads(run("tmux-ide-events", "-r", "-E", cap["journalEpoch"], "-a", "0"))
    owned = [record for record in records["records"] if record["correlation"] == operation]
    # The existing journal does not observe this new command. Its wrapper ACK
    # alone cannot stand in for the executor's owned-native completion proof.
    assert owned == [], owned
    evidence["cases"].append({"case": "guarded resize", "boundary": 83,
                              "receiptMatchesReadback": True, "ownedJournalRecords": 0})
    applied = layout()
    _, result = guarded(resize(original, 86))
    assert result.returncode != 0 and layout() == applied
    assert len(result.stdout.splitlines()) == 1
    assert json.loads(result.stdout)["type"] == "operation-identity"
    evidence["cases"].append({"case": "stale layout after wrapper admission",
                              "acknowledgedButRefused": True, "layoutUnchanged": True})
finally:
    try:
        run("kill-server")
        evidence["cleanup"] = True
    finally:
        shutil.rmtree(root)
        print(json.dumps(evidence, indent=2))
