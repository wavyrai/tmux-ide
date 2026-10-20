"""SPIKE: prove kitty APC bytes reach a tmux control-mode client.

Usage: [COLS=80 ROWS=24] /usr/bin/python3 probe-control.py TMUX SOCKET SEQ_DIR OUT allow-passthrough(on|off) NAME...
Starts an ISOLATED server on SOCKET (never the user's), attaches `tmux -C`,
has the pane `cat` each SEQ_DIR/NAME.seq, and records the raw control stream
to OUT plus a `capture-pane -e` to OUT.capture. Kills only that server.
"""
import os, subprocess, sys, time

TMUX, SOCKET, SEQ, OUT, PASSTHROUGH, *NAMES = sys.argv[1:]
env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
env["LANG"] = env.get("LANG") or "en_US.UTF-8"


def tmux(*args):
    return subprocess.run([TMUX, "-S", SOCKET, *args], env=env, capture_output=True, text=True)


tmux("kill-server")
tmux("-f", "/dev/null", "new-session", "-d", "-s", "zz-kitty", "-x", os.environ.get("COLS", "80"), "-y", os.environ.get("ROWS", "24"), "sh")
tmux("set", "-g", "allow-passthrough", PASSTHROUGH)
with open(OUT, "wb") as out:
    client = subprocess.Popen([TMUX, "-S", SOCKET, "-C", "attach", "-t", "zz-kitty"],
                              env=env, stdin=subprocess.PIPE, stdout=out)
    time.sleep(0.5)
    tmux("send-keys", "-t", "zz-kitty", "clear", "Enter")
    time.sleep(0.3)
    for name in NAMES:
        tmux("send-keys", "-t", "zz-kitty", f"cat {SEQ}/{name}.seq; echo DONE-{name}", "Enter")
        deadline = time.time() + 20
        while f"DONE-{name}\\015".encode() not in open(OUT, "rb").read() and time.time() < deadline:
            time.sleep(0.1)
    time.sleep(0.3)
    with open(OUT + ".capture", "w") as cap:
        cap.write(tmux("capture-pane", "-p", "-e", "-t", "zz-kitty").stdout)
    client.stdin.write(b"detach\n")
    client.stdin.flush()
    time.sleep(0.3)
    client.kill()
tmux("kill-server")
