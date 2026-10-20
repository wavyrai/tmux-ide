"""Pane workloads for the pipeline harness. Run inside a scratch tmux pane.

usage: workloads.py top SECONDS FPS | scroll SECONDS FPS | buildlog LINES | play DIR FPS
"""
import os
import random
import sys
import time

out = sys.stdout.buffer
ESC = b"\x1b"


def size():
    try:
        return os.get_terminal_size()
    except OSError:
        return os.terminal_size((80, 24))


def top(seconds, fps):
    """Process-monitor-like: fixed header and table, ~20% of cells change per frame."""
    cols, rows = size()
    out.write(ESC + b"[?1049h" + ESC + b"[?25l")
    rnd = random.Random(7)
    end = time.time() + seconds
    frame = 0
    while time.time() < end:
        start = time.time()
        buf = [ESC + b"[H"]
        load = " ".join(f"{rnd.random() * 4:.2f}" for _ in range(3))
        buf.append(f"\x1b[1;37;44m tasks: 312, load average: {load} frame {frame}".ljust(cols)[:cols].encode() + ESC + b"[0m")
        for r in range(1, rows):
            if r < 4:
                pct = rnd.randint(0, cols - 12)
                buf.append(ESC + b"[%d;1H" % (r + 1) + f" cpu{r} [\x1b[32m{'|' * pct}\x1b[0m{' ' * (cols - 12 - pct)}]".encode())
            elif rnd.random() < 0.35:
                line = f"{1000 + r:6d} user    20   0 {rnd.randint(1, 9999):6d}M {rnd.random() * 100:5.1f} {rnd.random() * 10:4.1f} 0:{rnd.randint(0, 59):02d}.{rnd.randint(0, 99):02d} process-{r}"
                buf.append(ESC + b"[%d;1H" % (r + 1) + line.ljust(cols)[:cols].encode())
        out.write(b"".join(buf))
        out.flush()
        frame += 1
        time.sleep(max(0, 1 / fps - (time.time() - start)))
    out.write(ESC + b"[?25h" + ESC + b"[?1049l")
    out.flush()


def scroll(seconds, fps):
    """Editor-like full-screen scroll: every row changes every frame."""
    cols, rows = size()
    out.write(ESC + b"[?1049h")
    words = "fn let mut match impl struct pub use return self where async await".split()
    rnd = random.Random(3)
    text = []
    for n in range(4000):
        indent = " " * (4 * rnd.randint(0, 3))
        line = indent + " ".join(rnd.choice(words) for _ in range(rnd.randint(2, 12)))
        text.append(f"\x1b[33m{n + 1:5d}\x1b[0m \x1b[36m{line}\x1b[0m"[: cols + 20])
    end = time.time() + seconds
    top_line = 0
    while time.time() < end:
        start = time.time()
        buf = [ESC + b"[H"]
        for r in range(rows):
            buf.append(ESC + b"[%d;1H" % (r + 1) + ESC + b"[2K" + text[(top_line + r) % len(text)].encode())
        out.write(b"".join(buf))
        out.flush()
        top_line += 1
        time.sleep(max(0, 1 / fps - (time.time() - start)))
    out.write(ESC + b"[?1049l")
    out.flush()


def buildlog(lines):
    rnd = random.Random(11)
    for n in range(lines):
        if n % 50 == 0:
            out.write(f"\x1b[1;32m   Compiling\x1b[0m crate-{n} v0.{n % 9}.{n % 31} (/work/src/crate-{n})\n".encode())
        elif n % 97 == 0:
            out.write(f"\x1b[1;33mwarning\x1b[0m: unused variable `x{n}` --> src/module_{n % 40}.rs:{n % 300}:9\n".encode())
        else:
            out.write(f"[{n:6d}/{lines}] cc -O2 -c src/file_{rnd.randint(0, 9999)}.c -o build/obj/file_{n}.o -Iinclude -DNDEBUG\n".encode())
    out.flush()


def play(directory, fps):
    files = sorted(f for f in os.listdir(directory) if f.endswith(".seq"))
    out.write(ESC + b"[2J")
    for name in files:
        start = time.time()
        with open(os.path.join(directory, name), "rb") as f:
            out.write(f.read())
        out.flush()
        time.sleep(max(0, 1 / fps - (time.time() - start)))
    out.write(ESC + b"[%d;1H" % (size().lines - 1))
    out.flush()


if __name__ == "__main__":
    kind = sys.argv[1]
    if kind == "top":
        top(float(sys.argv[2]), float(sys.argv[3]))
    elif kind == "scroll":
        scroll(float(sys.argv[2]), float(sys.argv[3]))
    elif kind == "buildlog":
        buildlog(int(sys.argv[2]))
    elif kind == "play":
        play(sys.argv[2], float(sys.argv[3]))
