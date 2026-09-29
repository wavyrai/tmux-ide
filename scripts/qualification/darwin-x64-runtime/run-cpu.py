"""One reviewed CPU attempt. No retry; preserve failure, full postclosure and cleanup receipts."""
import pathlib,json,subprocess,sys,time,os,signal
from binding import sha
from importlib.util import spec_from_file_location,module_from_spec

def load(name,path):
 spec=spec_from_file_location(name,path);m=module_from_spec(spec);spec.loader.exec_module(m);return m

def run(spec_path,authorization_path,overlay):
 spec_path=pathlib.Path(spec_path).resolve();s=json.loads(spec_path.read_text());a=json.loads(pathlib.Path(authorization_path).read_text())
 assert a['executionAuthorized'] is True and a['lane']=='cpu' and a['sourceCommit']==s['sourceCommit']
 assert a['frozenSpecSha256']==sha(spec_path),'Exact frozen spec approval required'
 root=spec_path.parent;attempt=root/'attempt.json'
 with attempt.open('x') as f:json.dump({'start':time.time(),'authorizationSha256':sha(authorization_path),'noRetry':True},f)
 verify=load('cpu_verify',s['verifyScript']).verify
 code=None;post=None
 try:
  before=verify(spec_path);(root/'preclosure.json').write_text(json.dumps(before))
  with (root/'campaign.log').open('xb') as log:
   child=subprocess.Popen([s['python'],str(pathlib.Path(overlay)/'cpu/campaign.py'),'--approved-campaign',str(spec_path)],stdout=log,stderr=subprocess.STDOUT,env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'),start_new_session=True)
   def cancel(signum,frame):
    if child.poll() is None:child.send_signal(signal.SIGTERM)
   previous={n:signal.signal(n,cancel) for n in [signal.SIGTERM,signal.SIGINT]}
   try:code=child.wait() # Campaign itself bounds each of 12 cases and its verifications; cancellation retires the active owned fixture.
   finally:
    for n,handler in previous.items():signal.signal(n,handler)
 finally:
  try:post=verify(spec_path);(root/'postclosure.json').write_text(json.dumps(post))
  except BaseException as e:(root/'postclosure-failure.json').write_text(json.dumps({'error':repr(e)}))
  rows=[]
  for p in sorted(pathlib.Path(s['output']).glob('*/result.json')):
   d=json.loads(p.read_text());rows.append({'path':str(p),'error':d.get('error'),'cleanup':d.get('cleanup')})
  cleanup_ok=len(rows)==12 and all(d['cleanup'] and not any('error' in x for x in d['cleanup']) for d in rows)
  (root/'terminal.json').write_text(json.dumps({'campaignExit':code,'postclosure':post is not None,'completeOwnedCleanup':cleanup_ok,'rows':rows,'scope':'Original CPU12; no other lane or retry'},indent=2))
 if code!=0 or post is None or not cleanup_ok:raise SystemExit('Retained failed CPU campaign; no retry')
if __name__=='__main__':run(*sys.argv[1:])
