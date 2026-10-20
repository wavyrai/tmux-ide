#!/usr/bin/env python3
"""refresh-client -C XxY/WxH: the control client's cell pixel size reaches CSI 14t/16t and TIOCGWINSZ."""
import os, pathlib, select, subprocess, sys, tempfile, time
binary = str(pathlib.Path(sys.argv[1]).resolve())
root = tempfile.mkdtemp(prefix='tmux-ide-cellpx-', dir='/tmp')
socket = root + '/sock'
env = {k: v for k, v in os.environ.items() if k not in ('TMUX', 'TMUX_PANE')}
PROBE = r'''
import os, sys, tty, select, time, fcntl, termios, struct
out = sys.argv[1]
fd = sys.stdin.fileno(); tty.setraw(fd)
time.sleep(float(sys.argv[2]))
os.write(1, b"\033[16t\033[14t\033[c")
got = b""; end = time.time() + 2
while time.time() < end and not got.endswith(b"c"):
    if select.select([fd], [], [], .1)[0]: got += os.read(fd, 4096)
rows, cols, xp, yp = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
open(out, "w").write(repr(got) + " winsize=%d,%d,%d,%d" % (rows, cols, xp, yp))
'''
def call(*args):
    p = subprocess.run([binary, '-S', socket, *args], env=env, text=True, capture_output=True, timeout=5)
    assert p.returncode == 0, (args, p.stderr)
    return p.stdout.strip()
try:
    out = root + '/probe.out'
    call('-f', '/dev/null', 'new-session', '-d', '-s', 'zz-cellpx', '-x', '80', '-y', '24', sys.executable, '-c', PROBE, out, '2')
    control = subprocess.Popen([binary, '-S', socket, '-C', 'attach', '-t', 'zz-cellpx'], env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
    control.stdin.write(b'refresh-client -C 80x24/20x40\n'); control.stdin.flush()
    end = time.time() + 6
    while not os.path.exists(out) and time.time() < end: time.sleep(.05)
    time.sleep(.2)
    result = open(out).read()
    assert "\\x1b[6;40;20t" in result and "\\x1b[4;" in result and "winsize=24,80,1600,960" in result, result
    # The probe exits, ending the session and the control client with it.
    control.wait(timeout=5)
    print('kitty-cell-pixels: ok')
finally:
    subprocess.run([binary, '-S', socket, 'kill-server'], env=env, capture_output=True)
