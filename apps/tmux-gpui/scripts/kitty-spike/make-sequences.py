"""SPIKE: write kitty graphics test sequences for the control-mode probe.

Usage: /usr/bin/python3 make-sequences.py OUT_DIR
Writes direct.seq (cursor-anchored a=T), chunked.seq (f=32 RGBA, m=1),
placeholder.seq (U=1 virtual placement + U+10EEEE cells), passthrough.seq
(DCS tmux; wrapped), demo.seq (both models, larger image) and big.seq
(a chunked 1920x1080 PNG for bandwidth measurement).
"""
import base64, math, os, struct, sys, zlib

OUT = sys.argv[1]
ESC = "\x1b"
# First 32 row/column diacritics (protocol order).
DIACRITICS = [chr(int(h, 16)) for h in (
    "0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357 "
    "035B 0363 0364 0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484").split()]


def png(w, h, pixel):
    rows = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def apc(control, payload=""):
    return f"{ESC}_G{control};{payload}{ESC}\\"


def chunked(control, data):
    b = base64.b64encode(data).decode()
    parts = [b[i:i + 4096] for i in range(0, len(b), 4096)]
    return "".join(apc((control + "," if i == 0 else "") + ("m=1" if i < len(parts) - 1 else "m=0"), p)
                   for i, p in enumerate(parts))


def placeholders(image_id, cols, rows, indent=""):
    lines = []
    for r in range(rows):
        cells = "".join("\U0010EEEE" + DIACRITICS[r] + DIACRITICS[c] for c in range(cols))
        lines.append(f"{indent}{ESC}[38;5;{image_id}m{cells}{ESC}[39m")
    return "\r\n".join(lines) + "\r\n"


def write(name, text):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        f.write(text)


small = png(40, 40, lambda x, y: (255 * (x < 20), 255 * (y < 20), 200))
b = base64.b64encode(small).decode()
write("direct.seq", "A" + apc("a=T,f=100,i=7,q=2", b) + "B\n")
rgba = bytes([255, 0, 0, 255] * 16)
r = base64.b64encode(rgba).decode()
write("chunked.seq", apc("a=t,f=32,s=4,v=4,i=8,m=1,q=2", r[:12]) + apc("m=1", r[12:40]) + apc("m=0", r[40:]) + "\n")
write("placeholder.seq", apc("a=T,f=100,i=9,U=1,c=3,r=2,q=2", b) + placeholders(9, 3, 2))
inner = apc("a=T,f=100,i=10,q=2", b).replace(ESC, ESC + ESC)
write("passthrough.seq", f"{ESC}Ptmux;{inner}{ESC}\\\n")


def demo_pixel(x, y, w=240, h=160):
    cx, cy = x - w / 2, y - h / 2
    ring = int(math.hypot(cx, cy) / 12) % 2
    return (int(255 * x / w), int(255 * y / h), 255 if ring else 90)


demo = png(240, 160, demo_pixel)
write("demo.seq",
      "cursor-anchored a=T (c=24,r=8):\r\n"
      + chunked("a=T,f=100,i=7,c=24,r=8,q=2", demo) + "\r\n" * 8
      + "unicode placeholders U=1 (c=24,r=8):\r\n"
      + chunked("a=t,f=100,i=9,q=2", demo) + apc("a=p,U=1,i=9,c=24,r=8,q=2")
      + placeholders(9, 24, 8))

W, H = 1920, 1080
big = png(W, H, lambda x, y: ((x * 255 // W) ^ ((y & 31) * 4), y * 255 // H, (x * y) & 255))
write("big.seq", chunked("a=T,f=100,i=20,q=2", big) + "\n")
print(f"1080p PNG {len(big)} bytes; RGBA would be {W * H * 4} bytes ({len(base64.b64encode(bytes(W * H * 4)))} base64)")
