"""Bounded telemetry drain for metadata lane only; never used in CPU lane."""
import json,queue,threading,time
from bounded_io import readline
class MetadataStream:
 def __init__(self,stream):
  self.messages=queue.Queue(maxsize=8);self.latencies=[];self.periods=[];self.last=None;self.error=None;self.batches=[]
  def drain():
   try:
    while True:
     line=readline(stream,10);seen=time.clock_gettime_ns(time.CLOCK_MONOTONIC)//1000
     obj=json.loads(line)
     if 'latency' not in obj:self.messages.put_nowait(obj);continue
     if self.last is not None:self.periods.append((seen-self.last)/1000)
     self.last=seen
     self.batches.append({'seenUs':seen,'backlog':obj.get('backlog',False),'batchSize':obj.get('batchSize',len(obj['latency']))})
     for sample in obj['latency']:
      self.latencies.append({'kind':sample['kind'],'milliseconds':(seen-int(sample['us']))/1000})
      if len(self.latencies)>6002:raise ValueError('Unexpected metadata count')
   except EOFError:pass
   except BaseException as error:self.error=repr(error)
  self.thread=threading.Thread(target=drain,daemon=True);self.thread.start()
 def reply(self):
  value=self.messages.get(timeout=5)
  if self.error:raise RuntimeError(self.error)
  return value
 def finish(self):
  self.thread.join(5)
  if self.thread.is_alive() or self.error:raise RuntimeError(self.error or 'Telemetry drain did not retire')
