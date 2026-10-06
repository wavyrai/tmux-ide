#!/usr/bin/env python3
"""Real-wire capture barrier and lifecycle qualification for an explicit tmux binary.

The reader deliberately stalls; received bytes are never reordered or synthesized.
A second no-output, ignore-size control client keeps PTY reads enabled while the
primary reader stalls (server_client_check_pane_buffer / control_pane_offset).
Each case owns and destroys a private server. Python 3 is a qualification dependency.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid


def qualify(binary, output, case):
    root = Path(tempfile.mkdtemp(prefix="tmux-control-barrier-"))
    socket = "zz-control-barrier-" + uuid.uuid4().hex[:12]
    env = {**os.environ, "TMUX": ""}
    control = None
    passive = None
    server_pid = None
    wire = bytearray()
    result = {"case": case, "socket": socket, "passed": False, "passiveClientFlags": "no-output,ignore-size"}

    def tm(*args):
        return subprocess.check_output(
            [str(binary), "-L", socket, "-f", "/dev/null", *args],
            env=env, stderr=subprocess.PIPE, timeout=4,
        ).decode().rstrip()

    def wait(predicate, description):
        end = time.monotonic() + 4
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(.01)
        raise AssertionError("fixture timeout: " + description)

    def drain(seconds, until=None):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if until is not None and until(bytes(wire)):
                return
            ready, _, _ = select.select([control.stdout], [], [], min(.05, end - time.monotonic()))
            if ready:
                chunk = os.read(control.stdout.fileno(), 65536)
                if not chunk:
                    return
                wire.extend(chunk)

    def command(value):
        control.stdin.write((value + "\n").encode())
        control.stdin.flush()

    def output_lines(pane):
        prefixes = (f"%output {pane} ".encode(), f"%extended-output {pane} ".encode())
        return [(index, line) for index, line in enumerate(bytes(wire).splitlines()) if line.startswith(prefixes)]

    try:
        producer = root / "producer.py"
        producer.write_text(
            "import os,tty\ntty.setraw(0)\nos.write(1,b'BEFORE')\n"
            "while True:\n c=os.read(0,1)\n"
            " data=c*2000000+b'\\r\\nDONE' if c in (b'B',b'C') else b'\\rAFTER!'\n"
            " while data:\n  written=os.write(1,data);data=data[written:]\n"
        )
        launch = shlex.join([sys.executable, str(producer)])
        a = tm("new-session", "-d", "-s", "test", "-x", "80", "-y", "24", "-P", "-F", "#{pane_id}", launch)
        server_pid = int(tm("display-message", "-p", "#{pid}"))
        result["controlOutputBarriers"] = tm("display-message", "-p", "#{tmux_ide_control_output_barriers}")
        b = tm("split-window", "-d", "-t", "test", "-P", "-F", "#{pane_id}", launch)
        for pane in (a, b):
            wait(lambda pane=pane: "BEFORE" in tm("capture-pane", "-p", "-t", pane), "producer ready")
        flags = ["-f", "ignore-size"]
        control = subprocess.Popen(
            [str(binary), "-L", socket, "-C", "attach", "-t", "test", *flags],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        # A no-output client explicitly keeps native PTY consumption enabled
        # even when the tested control reader is stalled. Without it tmux may
        # correctly stop the producer before DONE, invalidating that fence.
        passive = subprocess.Popen(
            [str(binary), "-L", socket, "-C", "attach", "-t", "test", "-f", "no-output,ignore-size"],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        drain(.15)
        assert passive.poll() is None, "passive control client failed to attach"
        wait(lambda: len(tm("list-clients", "-t", "test", "-F", "#{client_pid}").splitlines()) == 2, "both control clients attached")
        if case == "sibling-fairness":
            tm("send-keys", "-t", a, "-l", "C")
            tm("send-keys", "-t", b, "-l", "B")
            for pane, token in ((a, "CCCCCCCC"), (b, "BBBBBBBB")):
                wait(lambda pane=pane, token=token: token in tm("capture-pane", "-p", "-t", pane), "both floods started")
            drain(3, lambda _: bool(output_lines(a) and output_lines(b)))
            lines = bytes(wire).splitlines()
            first_a, first_b = output_lines(a)[0][0], output_lines(b)[0][0]
            # Both pending panes must be serviced before either full 2MB flood
            # drains. This catches accidentally replacing fair scheduling with
            # strict global data-block serialization.
            prefix_bytes = sum(len(line) for line in lines[:max(first_a, first_b) + 1])
            assert prefix_bytes < 1000000, f"sibling starved behind {prefix_bytes} wire bytes"
            result.update(firstA=first_a, firstB=first_b, bytesBeforeBoth=prefix_bytes)
        else:
            tm("send-keys", "-t", b, "-l", "B")
            wait(lambda: "BBBBBBBB" in tm("capture-pane", "-p", "-t", b), "backlog started")
            wait(lambda: "DONE" in tm("capture-pane", "-p", "-t", b), "entire flood enqueued before capture")
            enable_pause = " ; refresh-client -f pause-after=1" if case == "age-pause" else ""
            command(f"capture-pane -p -t {a} ; display-message -p BARRIER_ONE ; display-message -p BARRIER_TWO{enable_pause} ; set-option -g @barrier_taken 1")
            wait(lambda: tm("show-options", "-gqv", "@barrier_taken") == "1", "capture executed")
            if case == "age-pause":
                # Allow the *actual* queued block age to cross tmux's configured
                # one-second threshold; no scheduling result is inferred here.
                time.sleep(1.1)
            elif case == "pane-off":
                command(f"refresh-client -A '{b}:off' ; set-option -g @pane_off 1")
                wait(lambda: tm("show-options", "-gqv", "@pane_off") == "1", "off executed")
            elif case == "pane-death":
                tm("kill-pane", "-t", b)
            tm("send-keys", "-t", a, "-l", "A")
            wait(lambda: "AFTER!" in tm("capture-pane", "-p", "-t", a), "post-capture output parsed")
            command("display-message -p RESPONSIVE")
            drain(4, lambda data: b"\nRESPONSIVE\n" in data and any(b"AFTER!" in line for _, line in output_lines(a)))
            lines = bytes(wire).splitlines()
            capture = lines.index(b"BEFORE")
            one, two = lines.index(b"BARRIER_ONE"), lines.index(b"BARRIER_TWO")
            after = next(index for index, line in output_lines(a) if b"AFTER!" in line)
            responsive = lines.index(b"RESPONSIVE")
            assert capture < one < two < after, f"capture/reply seam overtaken: {capture}, {one}, {two}, {after}"
            assert responsive > two
            if case == "age-pause":
                drain(.2)
                lines = bytes(wire).splitlines()
                assert any(line == f"%pause {b}".encode() for line in lines), "did not exercise age-triggered pause"
                result["pauseLine"] = lines.index(f"%pause {b}".encode())
            # A fresh external command also detects a native event-loop spin.
            assert tm("display-message", "-p", "alive") == "alive"
            result.update(captureLine=capture, firstReplyLine=one, secondReplyLine=two,
                          afterOutputLine=after, responsiveLine=responsive)
        result["passed"] = True
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
        try:
            result["fixturePaneTail"] = tm("capture-pane", "-p", "-t", b)[-200:]
        except Exception:
            pass
    finally:
        try:
            subprocess.run([str(binary), "-L", socket, "kill-server"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except subprocess.TimeoutExpired:
            # A barrier-loop regression can make the server stop dispatching
            # commands. This PID was captured from this private server before
            # the trigger; never look up or signal an unrelated default server.
            result["passed"] = False
            result["cleanupForced"] = True
            if server_pid is not None:
                try:
                    os.kill(server_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for child in (control, passive):
            if child:
                try:
                    child.communicate(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate(timeout=2)
        absent = subprocess.run([str(binary), "-L", socket, "has-session"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode == 1
        result["serverAbsent"] = absent
        result["passed"] = result["passed"] and absent
        shutil.rmtree(root)
        (output / f"{case}.wire.log").write_bytes(wire)
        (output / f"{case}.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="absolute tmux executable to qualify")
    parser.add_argument("--output", type=Path, required=True, help="new evidence directory")
    parser.add_argument("--case", choices=["adjacent-replies", "age-pause", "pane-off", "pane-death", "sibling-fairness"], action="append")
    args = parser.parse_args()
    if not args.binary.is_absolute() or not os.access(args.binary, os.X_OK):
        parser.error("binary must be an absolute executable path")
    if args.case and len(set(args.case)) != len(args.case):
        parser.error("each --case may be selected only once")
    args.output.mkdir(parents=True, exist_ok=False)
    results = [qualify(args.binary, args.output, case) for case in (args.case or ["adjacent-replies", "age-pause", "pane-off", "pane-death", "sibling-fairness"])]
    receipt = {"binary": str(args.binary), "sha256": hashlib.sha256(args.binary.read_bytes()).hexdigest(),
               "version": subprocess.check_output([str(args.binary), "-V"], text=True).strip(), "results": results}
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    return 0 if all(result["passed"] for result in results) else 1


if __name__ == "__main__":
    sys.exit(main())
