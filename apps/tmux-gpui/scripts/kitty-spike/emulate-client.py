"""Emulate a full-frame kitty-graphics client running under tmux.

Usage: /usr/bin/python3 emulate-client.py LOG COLS ROWS FPS SECONDS [CELL_W CELL_H]

This is the shape kitty-graphics clients use when they detect tmux:

- one image id is re-transmitted every frame as a `U=1` virtual placement;
- each transmission is RGBA, zlib-deflated (`o=z`), sent in 4096-byte base64
  chunks, every chunk wrapped in `DCS tmux;`;
- the placeholder grid is printed once with a 24-bit foreground colour id;
- frames are wrapped in synchronized output.

The frame is a page that scrolls by a few pixels per frame, under two
translucent toolbar rows and a translucent scrollbar column. LOG receives one
JSON line per frame with its write time and both possible digests (of the raw
and of the deflated pixels).
"""
import base64, hashlib, json, os, sys, time, zlib

LOG, COLS, ROWS, FPS, SECONDS = sys.argv[1], *map(int, sys.argv[2:5]), float(sys.argv[5])
CW, CH = (int(sys.argv[6]), int(sys.argv[7])) if len(sys.argv) > 7 else (8, 16)
W, H = COLS * CW, ROWS * CH
IMAGE_ID = 0x0A0B0C
ESC = "\x1b"
DIACRITICS = [chr(int(h, 16)) for h in (
    "0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357 "
    "035B 0363 0364 0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484 "
    "0485 0486 0487 0592 0593 0594 0595 0597 0598 0599 059C 059D 059E 059F 05A0 05A1 "
    "05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612 0613 0614 0615 0616 0617 0657 0658 "
    "0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC 06DF 06E0 06E1 06E2 "
    "06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741 0743 "
    "0745 0747 0749 074A 07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819 "
    "081B 081C 081D 081E 081F 0820 0821 0822 0823 0825 0826 0827 0829 082A 082B 082C "
    "082D 0951 0953 0954 0F82 0F83 0F86 0F87 135D 135E 135F 17DD 193A 1A17 1A75 1A76 "
    "1A77 1A78 1A79 1A7A 1A7B 1A7C 1B6B 1B6D 1B6E 1B6F 1B70 1B71 1B72 1B73 1CD0 1CD1 "
    "1CD2 1CDA 1CDB 1CE0 1DC0 1DC1 1DC3 1DC4 1DC5 1DC6 1DC7 1DC8 1DC9 1DCB 1DCC 1DD1 "
    "1DD2 1DD3 1DD4 1DD5 1DD6 1DD7 1DD8 1DD9 1DDA 1DDB 1DDC 1DDD 1DDE 1DDF 1DE0 1DE1 "
    "1DE2 1DE3 1DE4 1DE5 1DE6 1DFE 20D0 20D1 20D4 20D5 20D6 20D7 20DB 20DC 20E1 20E7 "
    "20E9 20F0 2CEF 2CF0 2CF1 2DE0 2DE1 2DE2 2DE3 2DE4 2DE5 2DE6 2DE7 2DE8 2DE9 2DEA "
    "2DEB 2DEC 2DED 2DEE 2DEF 2DF0 2DF1 2DF2 2DF3 2DF4 2DF5 2DF6 2DF7 2DF8 2DF9 2DFA "
    "2DFB 2DFC 2DFD 2DFE 2DFF A66F A67C A67D A6F0 A6F1 A8E0 A8E1 A8E2 A8E3 A8E4 A8E5 "
    "A8E6 A8E7 A8E8 A8E9 A8EA A8EB A8EC A8ED A8EE A8EF A8F0 A8F1 AAB0 AAB2 AAB3 AAB7 "
    "AAB8 AABE AABF AAC1 FE20 FE21 FE22 FE23 FE24 FE25 FE26 10A0F 10A38 1D185 1D186 1D187 "
    "1D188 1D189 1D1AA 1D1AB 1D1AC 1D1AD 1D242 1D243 1D244 ").split()]
assert COLS <= len(DIACRITICS) and ROWS <= len(DIACRITICS)


def wrap(sequence):
    return f"{ESC}Ptmux;" + sequence.replace(ESC, ESC + ESC) + f"{ESC}\\"


def frame_pixels(scroll):
    toolbar = 2 * CH
    rows = []
    for y in range(H):
        if y < toolbar:
            row = bytes((0, 0, 0, 0)) * W  # transparent toolbar (as recorded clients draw it)
        else:
            band = ((y + scroll) // 24) % 2
            shade = 235 if band else 250
            line = bytes((shade, shade, shade, 255)) * (W - CW)
            text = ((y + scroll) % 24) in (8, 9, 10)
            if text:
                line = bytes((30, 30, 30, 255)) * ((W - CW) // 2) + line[((W - CW) // 2) * 4:]
            row = line + bytes((0, 0, 0, 0)) * CW  # transparent scrollbar column
        rows.append(row)
    # Stamp the frame number into the page so every frame is distinct.
    stamp = scroll.to_bytes(4, "big")
    rows[2 * CH] = stamp + rows[2 * CH][4:]
    return b"".join(rows)


def transmit(compressed):
    payload = base64.b64encode(compressed).decode()
    parts = [payload[i:i + 4096] for i in range(0, len(payload), 4096)]
    out = []
    for index, part in enumerate(parts):
        more = 1 if index < len(parts) - 1 else 0
        keys = (f"a=T,f=32,o=z,s={W},v={H},t=d,i={IMAGE_ID},U=1,c={COLS},r={ROWS},q=2,m={more}"
                if index == 0 else f"m={more}")
        out.append(wrap(f"{ESC}_G{keys};{part}{ESC}\\"))
    return "".join(out)


def placeholders():
    r, g, b = IMAGE_ID >> 16 & 255, IMAGE_ID >> 8 & 255, IMAGE_ID & 255
    out = [f"{ESC}[38;2;{r};{g};{b}m"]
    for row in range(ROWS):
        out.append(f"{ESC}[{row + 1};1H")
        out.append("".join("\U0010EEEE" + DIACRITICS[row] + DIACRITICS[col] for col in range(COLS)))
    out.append(f"{ESC}[39m")
    return "".join(out)


log = open(LOG, "w")
out = os.fdopen(sys.stdout.fileno(), "wb", buffering=0)
start = time.monotonic()
frame = 0
next_at = start
while time.monotonic() - start < SECONDS:
    pixels = frame_pixels(frame * 3)  # scroll is unique per frame
    compressed = zlib.compress(pixels, 1)
    body = transmit(compressed) + (placeholders() if frame == 0 else "")
    data = f"{ESC}[?2026h{body}{ESC}[?2026l".encode()
    out.write(data)
    log.write(json.dumps({
        "frame": frame,
        "writtenAt": time.time(),
        "bytes": len(data),
        "rawDigest": hashlib.sha256(pixels).hexdigest()[:32],
        "zlibDigest": hashlib.sha256(compressed).hexdigest()[:32],
    }) + "\n")
    log.flush()
    frame += 1
    next_at += 1 / FPS
    delay = next_at - time.monotonic()
    if delay > 0:
        time.sleep(delay)
log.close()
