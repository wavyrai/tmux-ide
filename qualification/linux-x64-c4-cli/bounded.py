"""Bound output while it is produced; own process groups only."""
import os,signal,subprocess,select,time
from types import SimpleNamespace

def run_bounded(args, *, timeout=30, limit=1048576, output=None, cwd=None, env=None):
    p=subprocess.Popen(args,cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
    deadline=time.monotonic()+timeout;captured=bytearray();total=0;forced=None
    try:
        while True:
            if time.monotonic()>=deadline:forced=124;break
            if not select.select([p.stdout],[],[],min(.1,max(0,deadline-time.monotonic())))[0]:continue
            chunk=os.read(p.stdout.fileno(),65536)
            if not chunk:break
            allowed=chunk[:max(0,limit-total)]
            if output:output.write(allowed)
            else:captured.extend(allowed)
            total+=len(chunk)
            if total>limit:forced=125;break
        if forced is not None:
            try:os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            p.wait(timeout=5)
        else:
            try:p.wait(timeout=max(.01,deadline-time.monotonic()))
            except subprocess.TimeoutExpired:
                os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5);forced=124
        return SimpleNamespace(returncode=forced if forced is not None else p.returncode,stdout=captured.decode('utf8',errors='replace'),bytes=min(total,limit),truncated=total>limit)
    finally:
        p.stdout.close()
        if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
