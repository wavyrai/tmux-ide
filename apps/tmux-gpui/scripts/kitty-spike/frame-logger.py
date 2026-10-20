"""Raw pane logger for `tmux pipe-pane`: keeps the bytes and times frames.

Usage: pipe-pane -o 'python3 frame-logger.py RAW FRAMES'

RAW receives the pane's output verbatim. FRAMES receives one JSON line per
completed kitty transmission (`a=T`/`a=t`, all `m=1` chunks), with the time
its last chunk was read and the digest the daemon assigns to deflated pixels
(sha256 of the decoded payload, first 32 hex digits).
"""
import base64, hashlib, json, os, re, sys, time

raw = open(sys.argv[1], "wb")
frames = open(sys.argv[2], "w")
apc = re.compile(rb"\x1b(?:\x1b)?_G([^;\x1b]*);([^\x1b]*)\x1b(?:\x1b)?\\")
pending = b""
payload = None
while True:
    data = os.read(0, 1 << 20)
    if not data:
        break
    raw.write(data)
    pending += data
    end = 0
    for match in apc.finditer(pending):
        keys = dict(p.split(b"=", 1) for p in match.group(1).split(b",") if b"=" in p)
        if keys.get(b"a") in (b"T", b"t") and b"i" in keys:
            payload = [match.group(2)]
        elif payload is not None and set(keys) == {b"m"}:
            payload.append(match.group(2))
        else:
            payload = None
        if payload is not None and keys.get(b"m", b"0") == b"0":
            body = base64.b64decode(b"".join(payload))
            frames.write(json.dumps({
                "at": time.time(),
                "digest": hashlib.sha256(body).hexdigest()[:32],
                "bytes": len(body),
            }) + "\n")
            frames.flush()
            payload = None
        end = match.end()
    pending = pending[end:][-(1 << 22):]
raw.close()
frames.close()
