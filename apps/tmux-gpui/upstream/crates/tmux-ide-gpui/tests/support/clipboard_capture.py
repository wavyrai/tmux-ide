"""Synthetic native fixture: raw terminal input, never a personal terminal."""
import os
import pathlib
import select
import shlex
import sys
import termios
import time
import tty
import zlib
import struct

label = sys.argv[1]
endpoint, name = label.split("_", 1)
previous = termios.tcgetattr(0)
try:
    tty.setraw(0)
    os.write(1, b"\x1b[?2004h\r\nCLIP_READY_" + label.encode() + b"\r\n")
    received = bytearray()
    deadline = time.monotonic() + 8
    while not received.endswith(b"!AFTER\r"):
        assert time.monotonic() < deadline, "input deadline"
        if select.select([0], [], [], 0.1)[0]:
            received.extend(os.read(0, 4096))
        assert len(received) < 8192, "unexpected input size"
    payload = bytes(received)
    assert payload.startswith(b"\x1b[200~"), "missing paste start"
    assert payload.endswith(b"\x1b[201~!AFTER\r"), "paste/input order"
    payload = payload[6:-len(b"\x1b[201~!AFTER\r")]
    expected = {
        "text": "plain text",
        "unicode": "你好 café 🐏",
        "multiline": "first\n第二行\nlast\n",
    }
    if name in expected:
        assert payload == expected[name].encode(), "exact UTF-8 paste bytes"
    else:
        original = pathlib.Path.home() / "clipboard-source.png"
        if name == "path" and endpoint == "local":
            assert payload == str(original).encode(), "local path must remain literal"
        paths = shlex.split(payload.decode())
        assert len(paths) == 1, "one pasted image path"
        path = pathlib.Path(paths[0])
        assert path.is_absolute() and path.suffix == ".png", "PNG staging path"
        # Decode the tiny synthetic PNG independently of the Rust image encoder.
        data = path.read_bytes()
        if name in ("png", "path"):
            assert data == original.read_bytes(), "PNG upload preserves exact bytes"
        if name == "path" and endpoint == "remote":
            assert path != original, "remote path must use daemon image staging"
        assert data[:8] == b"\x89PNG\r\n\x1a\n", "PNG signature"
        compressed = bytearray()
        offset = 8
        while offset < len(data):
            length = struct.unpack(">I", data[offset:offset + 4])[0]
            kind = data[offset + 4:offset + 8]
            chunk = data[offset + 8:offset + 8 + length]
            if kind == b"IHDR":
                assert struct.unpack(">IIBBBBB", chunk) == (2, 2, 8, 6, 0, 0, 0)
            if kind == b"IDAT":
                compressed.extend(chunk)
            offset += length + 12
        raster = zlib.decompress(compressed)
        previous_row = [0] * 8
        for y in range(2):
            filter_kind = raster[y * 9]
            row = list(raster[y * 9 + 1:y * 9 + 9])
            for x in range(8):
                left = row[x - 4] if x >= 4 else 0
                up = previous_row[x]
                upper_left = previous_row[x - 4] if x >= 4 else 0
                p = left + up - upper_left
                distances = [abs(p - v) for v in (left, up, upper_left)]
                paeth = (left, up, upper_left)[distances.index(min(distances))]
                predictor = (0, left, up, (left + up) // 2, paeth)[filter_kind]
                row[x] = (row[x] + predictor) & 255
            assert row == [17, 83, 191, 255] * 2, "exact image pixels"
            previous_row = row
except Exception:
    os.write(1, b"\r\nCLIP_FAIL_" + label.encode() + b"\r\n")
    raise
finally:
    os.write(1, b"\x1b[?2004l")
    termios.tcsetattr(0, termios.TCSANOW, previous)
print("\r\nCLIP_DONE_" + label, flush=True)
