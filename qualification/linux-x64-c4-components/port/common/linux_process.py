"""Bounded private adapter to the reviewed Node Linux identity sampler; no proc parser."""
import json,pathlib,subprocess,time
NODE='/opt/node26/bin/node';BRIDGE=pathlib.Path(__file__).resolve().with_name('proc-bridge.mjs')
_witnesses={}
def request(op,_timeout=12,**args):
 payload=json.dumps(dict(op=op,witnesses=list(_witnesses.values()),**args))
 r=subprocess.run([NODE,str(BRIDGE)],input=payload,text=True,capture_output=True,timeout=_timeout,env={'PATH':'/opt/node26/bin:/usr/bin:/bin','LC_ALL':'C','TZ':'UTC'})
 if r.returncode:raise RuntimeError('Owned process probe failed: '+r.stderr[-8192:])
 if len(r.stdout)>1048576:raise RuntimeError('Oversized process response')
 data=json.loads(r.stdout)
 for row in data['witnesses']:
  old=_witnesses.get(row['pid'])
  if old and old['startIdentity']!=row['startIdentity']:raise RuntimeError('Witness changed')
  _witnesses[row['pid']]=row
 return data['result']
def reset():_witnesses.clear()
def witnesses():return list(_witnesses.values())
def sample(pid):return request('sample',pid=int(pid))
def snapshot(pid):
 result=request('snapshot',pids=[int(pid)])
 if result['errors']:raise RuntimeError('Descendant enumeration uncertain: '+json.dumps(result))
 return result
def assert_live(pid):return sample(pid)
def prove_absent(pids,timeout=5):
 deadline=time.monotonic()+timeout
 while True:
  remaining=[]
  for pid in set(pids)|set(_witnesses):
   budget=deadline-time.monotonic()
   if budget<=0:raise TimeoutError('Owned absence deadline exceeded')
   if not request('retired',pid=int(pid),_timeout=min(12,budget)):remaining.append(int(pid))
  if not remaining:return
  if time.monotonic()>=deadline:raise TimeoutError('Owned originals not retired: '+str(remaining))
  time.sleep(.01)
