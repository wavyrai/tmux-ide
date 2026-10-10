#!/usr/bin/python3
"""SSH-shaped process transport, exclusively to the explicitly isolated socket.

No SSH executable, network host, remote shell command, or daemon discovery runs.
The real client SSH worker negotiates this bridge and uses its normal wire path.
"""
import json
import os
import select
import socket
import sys

assert sys.argv[-2] == "clipboard-fixture.invalid", "unexpected SSH destination"
assert os.environ["HOME"] == os.environ["XDG_RUNTIME_DIR"], "not sandboxed"
path = os.environ["HERDR_CLIENT_SOCKET_PATH"]
assert os.path.dirname(path) == os.environ["HOME"], "socket outside sandbox"
status = {
    "endpoint_protocol_generation": 1,
    "endpoint_capabilities": ["surface_interest", "presentation_effects_fence", "health_check"],
}
os.write(1, json.dumps(status).encode() + b"\nherdr-remote-output-ready:1\n")
choice = bytearray()
while not choice.endswith(b"\n"):
    byte = os.read(0, 1)
    assert byte, "client closed during discovery"
    choice.extend(byte)
    assert len(choice) < 32
assert choice == b"accept\n"
with socket.socket(socket.AF_UNIX) as peer:
    peer.connect(path)
    while True:
        ready, _, _ = select.select([0, peer], [], [])
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            peer.sendall(data)
        if peer in ready:
            data = peer.recv(65536)
            if not data:
                break
            while data:
                count = os.write(1, data)
                data = data[count:]
