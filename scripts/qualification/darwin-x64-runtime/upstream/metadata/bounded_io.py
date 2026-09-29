"""Bound harness waits without changing the measured CPU accounting."""
import os,select,time,subprocess
_buffers={}
def readline(stream,timeout=5):
 fd=stream.fileno();deadline=time.monotonic()+timeout
 data=_buffers.pop(fd,b'')
 while b'\n' not in data:
  remaining=deadline-time.monotonic()
  if remaining<=0 or not select.select([fd],[],[],remaining)[0]:raise TimeoutError('Reader reply timed out')
  chunk=os.read(fd,65536)
  if not chunk:raise EOFError('Reader exited without complete reply')
  data+=chunk
  if len(data)>1048576:raise ValueError('Reader reply exceeds limit')
 line,rest=data.split(b'\n',1)
 if rest:_buffers[fd]=rest
 return line.decode()
def wait4(pid,timeout=5):
 deadline=time.monotonic()+timeout
 while True:
  result=os.wait4(pid,os.WNOHANG)
  if result[0]:return result
  if time.monotonic()>=deadline:raise TimeoutError('Reader exit timed out')
  time.sleep(.005)
def absent(pid):
 try:os.kill(int(pid),0)
 except ProcessLookupError:return True
 return False
def prove_absent(pids,timeout=5):
 deadline=time.monotonic()+timeout
 while True:
  remaining=[int(p) for p in pids if not absent(p)]
  if not remaining:return
  if time.monotonic()>=deadline:raise TimeoutError('Owned processes still present: '+str(remaining))
  time.sleep(.01)
def retire_socket(path,witness):
 import stat
 try:current=os.lstat(path)
 except FileNotFoundError:return
 if witness is None or (current.st_dev,current.st_ino,current.st_uid)!=witness or not stat.S_ISSOCK(current.st_mode) or current.st_uid!=os.getuid():raise RuntimeError('Socket ownership changed; refusing unlink')
 os.unlink(path)
