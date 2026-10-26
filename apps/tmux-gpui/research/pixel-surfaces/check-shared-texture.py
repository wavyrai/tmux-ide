"""Bounded two-process Metal/shared-memory feasibility check; no personal daemon."""
import argparse
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("binary", type=Path)
parser.add_argument("--frames", type=int, default=30)
args = parser.parse_args()
if not 1 <= args.frames <= 120:
    parser.error("frames must be between 1 and 120")
binary = args.binary.resolve(strict=True)
children = []
deadline = time.monotonic() + 90


def line(child):
    output = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([child.stdout], [], [], remaining)[0]:
            raise RuntimeError("owned pixel probe deadline")
        value = os.read(child.stdout.fileno(), 1)
        if not value:
            raise RuntimeError("pixel probe exited before completing the handshake")
        if value == b"\n":
            return output.decode("ascii")
        output.extend(value)
        if len(output) > 16:
            raise RuntimeError("oversized probe reply")


with tempfile.TemporaryDirectory(prefix="tmux-pixel-probe-") as directory:
    try:
        def start(mode):
            child = subprocess.Popen(
                [str(binary), mode, str(Path(directory) / "frame"), str(args.frames)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0,
                env={"PATH": "/usr/bin:/bin", "HOME": directory},
            )
            children.append(child)
            if line(child) != "ready":
                raise RuntimeError("probe was not ready")
            return child

        producer = start("producer")
        consumer = start("consumer")
        for frame in range(1, args.frames + 1):
            if line(producer) != str(frame):
                raise RuntimeError("producer sequence mismatch")
            consumer.stdin.write(f"{frame}\n".encode())
            if line(consumer) != str(frame):
                raise RuntimeError("GPU completion sequence mismatch")
            producer.stdin.write(f"{frame}\n".encode())
        for child in children:
            child.stdin.close()
            if child.wait(timeout=5) != 0:
                raise RuntimeError("probe process failed")
        print(json.dumps({
            "ok": True, "framesVerified": args.frames, "width": 1920, "height": 1200,
            "processes": 2, "transport": "private mmap + bounded pipe acknowledgments",
            "gpu": "Metal texture over bytesNoCopy shared buffer; every row checksum verified",
            "limitations": ["CPU producer", "no IOSurface IPC", "no GPUI paint", "no remote transport", "no latency claim"],
        }, indent=2))
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)
            if child.stdin and not child.stdin.closed:
                child.stdin.close()
            if child.stdout:
                child.stdout.close()
