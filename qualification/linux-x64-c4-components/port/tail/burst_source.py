"""Fixed bounded command file avoids tmux's 1000-argument IPC limit."""
import os
from pathlib import Path
PAIR='send-keys -t probe -l x\ncapture-pane -p -t probe\n'
def write_burst(path,pairs):
 if isinstance(pairs,bool) or not isinstance(pairs,int) or not 1<=pairs<=471:raise ValueError('Invalid burst size')
 body=(PAIR*pairs).encode('ascii')
 assert len(body)<=32768
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as stream:stream.write(body)
 return {'pairs':pairs,'commands':pairs*2,'bytes':len(body),'path':str(path)}
def bounded_failure(error):
 def text(value):
  if value is None:return None
  if not isinstance(value,bytes):value=str(value).encode('utf8')
  return value[:2048].decode('utf8',errors='replace')
 return {'type':type(error).__name__,'returncode':getattr(error,'returncode',None),'stderr':text(getattr(error,'stderr',None)),'stdout':text(getattr(error,'stdout',None))}
