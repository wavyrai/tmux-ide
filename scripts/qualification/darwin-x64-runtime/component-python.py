"""Translate cancellation into the original Python driver's retained failure/finally cleanup."""
import signal,runpy,sys,pathlib
cancelled=False
def cancel(signum,frame):
 global cancelled
 if not cancelled:
  cancelled=True
  raise KeyboardInterrupt('Qualification cancelled')
for s in (signal.SIGTERM,signal.SIGINT):signal.signal(s,cancel)
entry=pathlib.Path(sys.argv[1]).resolve();sys.argv=sys.argv[1:];sys.path.insert(0,str(entry.parent))
runpy.run_path(str(entry),run_name='__main__')
