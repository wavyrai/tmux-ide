#!/usr/bin/env python3
"""kitty-graphics option: in-order acknowledgements, never a pane title."""
import os, pathlib, subprocess, sys, tempfile, time
binary = str(pathlib.Path(sys.argv[1]).resolve())
root = tempfile.mkdtemp(prefix='tmux-ide-kitty-', dir='/tmp')
socket = root + '/sock'
env = {k: v for k, v in os.environ.items() if k not in ('TMUX', 'TMUX_PANE')}
PROBE = r'''
import os, sys, termios, tty, select, time
out, data = sys.argv[1], bytes.fromhex(sys.argv[2])
fd = sys.stdin.fileno(); tty.setraw(fd)
os.write(1, data); got = b''; end = time.time() + 2
while time.time() < end and not got.endswith(b'c'):
    if select.select([fd], [], [], .1)[0]: got += os.read(fd, 4096)
open(out, 'wb').write(got)
'''
def call(*args):
    p = subprocess.run([binary, '-S', socket, *args], env=env, text=True, capture_output=True, timeout=5)
    assert p.returncode == 0, (args, p.stderr)
    return p.stdout.strip()
def probe(name, data, option):
    out = f'{root}/{name}.out'
    call('set-option', '-g', 'kitty-graphics', option)
    call('new-window', '-d', '-n', name, sys.executable, '-c', PROBE, out, data.hex())
    end = time.time() + 5
    while not os.path.exists(out) and time.time() < end: time.sleep(.05)
    time.sleep(.1)
    title = call('display-message', '-p', '-t', ':' + name, '#{pane_title}')
    return open(out, 'rb').read(), title
apc = lambda body: b'\033_G' + body + b'\033\\'
DA1 = b'\033[c'
ok = lambda ids: b'\033_G' + ids + b';OK\033\\'
try:
    call('-f', '/dev/null', 'new-session', '-d', '-s', 'zz-kitty', '-x', '80', '-y', '24', 'cat')
    got, title = probe('off', apc(b'a=q,i=31,s=1,v=1,f=24;AAAA') + DA1, 'off')
    assert not got.startswith(b'\033_G') and got.endswith(b'c'), got
    assert not title.startswith('G'), title
    got, title = probe('query', apc(b'a=q,i=31,s=1,v=1,f=24;AAAA') + DA1, 'on')
    assert got.startswith(ok(b'i=31')) and got.endswith(b'c'), got
    assert not title.startswith('G'), title
    got, _ = probe('chunked', apc(b'a=T,f=100,i=5,p=2,m=1;AAAA') + apc(b'm=1;AAAA') + apc(b'm=0;AAAA') + DA1, 'on')
    assert got.count(b';OK') == 1 and got.startswith(ok(b'i=5,p=2')), got
    got, _ = probe('quiet', apc(b'a=T,f=100,i=6,q=2;AAAA') + apc(b'a=q,i=7,q=1;AAAA') + DA1, 'on')
    assert b'\033_G' not in got and got.endswith(b'c'), got
    got, _ = probe('anonymous', apc(b'a=T,f=100;AAAA') + DA1, 'on')
    assert b'\033_G' not in got, got
    wrapped = b'\033Ptmux;' + apc(b'a=q,i=9;AAAA').replace(b'\033', b'\033\033') + b'\033\\'
    got, _ = probe('wrapped', wrapped + DA1, 'on')
    assert got.startswith(ok(b'i=9')), got
    # File and shared-memory media never reach the renderer: refuse them so
    # clients fall back to direct data. q=2 silences the refusal too.
    for medium in (b's', b'f', b't'):
        got, _ = probe('medium-' + medium.decode(), apc(b'a=q,i=299,t=' + medium + b',f=32,s=1,v=1;L3B4') + DA1, 'on')
        assert got.startswith(b'\033_Gi=299;EINVAL:') and got.endswith(b'c'), (medium, got)
    got, _ = probe('medium-quiet', apc(b'a=T,i=4,t=s,f=32,s=1,v=1,q=2;L3B4') + DA1, 'on')
    assert b'\033_G' not in got, got
    got, _ = probe('medium-direct', apc(b'a=q,i=300,t=d,f=32,s=1,v=1;AAAA') + DA1, 'on')
    assert got.startswith(ok(b'i=300')), got
    # Frame edits are acknowledged, including after chunking.
    got, _ = probe('frame-edit', apc(b'a=t,f=32,s=1,v=1,i=302,q=1;AAAA') + apc(b'a=f,f=32,i=302,r=1,X=1,x=0,y=0,s=1,v=1,m=1;AA') + apc(b'm=0;AA') + DA1, 'on')
    assert got.count(b';OK') == 1 and got.startswith(ok(b'i=302')), got
    print('kitty-graphics: ok')
finally:
    subprocess.run([binary, '-S', socket, 'kill-server'], env=env, capture_output=True)
