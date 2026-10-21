#!/usr/bin/env python3
"""Owned-server regression: fractional cell metrics reach pane ioctl and CSI 14t."""
import os, pathlib, subprocess, sys, tempfile, time
binary = str(pathlib.Path(sys.argv[1]).resolve())
root = tempfile.mkdtemp(prefix='tmux-ide-precisepx-')
socket = root + '/sock'
env = {k: v for k, v in os.environ.items() if k not in ('TMUX', 'TMUX_PANE')}
PROBE = r'''
import os, sys, tty, select, time, fcntl, termios, struct
fd = sys.stdin.fileno(); tty.setraw(fd)
while True:
    if not select.select([fd], [], [], 5)[0]: continue
    if os.read(fd, 1) != b'p': continue
    os.write(1, b"\033[14t\033[16t\033[c")
    got = b""; end = time.time() + 2
    while time.time() < end and not got.endswith(b"c"):
        if select.select([fd], [], [], .1)[0]: got += os.read(fd, 4096)
    dims = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))
    open(sys.argv[1], "w").write(repr(got) + " " + ",".join(map(str, dims)))
'''
def call(*args):
    p = subprocess.run([binary, '-S', socket, *args], env=env, text=True, capture_output=True, timeout=5)
    assert p.returncode == 0, (args, p.stderr)
    return p.stdout.strip()
def probe(pane, output, milli):
    if os.path.exists(output): os.unlink(output)
    call('send-keys', '-t', pane, 'p')
    end = time.time() + 4
    while not os.path.exists(output) and time.time() < end: time.sleep(.05)
    result = pathlib.Path(output).read_text()
    rows, cols, xp, yp = map(int, result.rsplit(' ', 1)[1].split(','))
    expected = (min(65535, (cols*milli[0]+500)//1000), min(65535, (rows*milli[1]+500)//1000))
    assert (xp, yp) == expected, (result, expected)
    assert f'\\x1b[4;{yp};{xp}t' in result, result
    return cols, rows, xp, yp
try:
    output = root + '/probe'
    pane = call('-f', '/dev/null', 'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', 'precisepx', '-x', '110', '-y', '34', sys.executable, '-c', PROBE, output)
    call('set-option', '-g', 'status', 'off')
    control = subprocess.Popen([binary, '-S', socket, '-C', 'attach', '-t', 'precisepx'], env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
    def metrics(suffix):
        control.stdin.write(('refresh-client -C 110x34/' + suffix + '\n').encode()); control.stdin.flush(); time.sleep(.2)
    metrics('17x40/16860x40000')
    assert probe(pane, output, (16860,40000)) == (110,34,1855,1360)
    metrics('17x40/16750x40000') # same rounded cell, changed total pixels
    probe(pane, output, (16750,40000))
    other = root + '/other'
    pane2 = call('split-window','-h','-P','-F','#{pane_id}','-t',pane,sys.executable,'-c',PROBE,other)
    time.sleep(.2)
    probe(pane, output, (16750,40000)); probe(pane2, other, (16750,40000))
    metrics('17x40') # old clients retain integer fallback
    probe(pane, output, (17000,40000)); probe(pane2, other, (17000,40000))
    print('precise-cell-pixels: exact totals, precision-only updates, splits, fallback OK')
finally:
    subprocess.run([binary, '-S', socket, 'kill-server'], env=env, capture_output=True)
