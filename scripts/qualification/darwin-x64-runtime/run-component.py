"""One original component lane, exact authorization and unconditional closure evidence."""
import pathlib,json,subprocess,sys,os,signal,time,importlib.util
from binding import sha
BASE=pathlib.Path(__file__).resolve().parent

def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def command(s):
 lane=s['lane'];directory=pathlib.Path(s['overlay'])/lane
 if lane=='parser':return [s['node'],'--import',str(BASE/'component-cancel.mjs'),str(directory/'echo.mjs'),s['binary'],s['output'],'qualification']
 assert lane in ['metadata','tail']
 return [s['python'],str(BASE/'component-python.py'),str(directory/('metadata.py' if lane=='metadata' else 'tail_backlog.py')),'--approved-metadata' if lane=='metadata' else '--approved-tail-backlog']

def result_rows(s):
 root=pathlib.Path(s['output']);name={'parser':'report.json','metadata':'metadata-results.json','tail':'tail-backlog-results.json'}[s['lane']]
 return json.loads((root/name).read_text())['runs']

def validate(s,rows):
 sys.path.insert(0,str(BASE/'component-gates'))
 try:return load('gate_'+s['lane'],BASE/'component-gates'/(s['lane']+'_gate.py')).validate(rows)
 finally:sys.path.pop(0)

def run(spec_path,authorization_path):
 spec_path=pathlib.Path(spec_path).resolve();s=json.loads(spec_path.read_text());a=json.loads(pathlib.Path(authorization_path).read_text())
 assert s['lane'] in ['parser','metadata','tail'] and a['lane']==s['lane'] and a['executionAuthorized'] is True
 assert a['sourceCommit']==s['sourceCommit'] and a['frozenSpecSha256']==sha(spec_path)
 root=spec_path.parent
 with (root/'attempt.json').open('x') as f:json.dump({'start':time.time(),'authorizationSha256':sha(authorization_path),'noRetry':True},f)
 verify=load('component_verify',s['verifyScript']).verify
 code=None;post=None;failure=None;rows=[];summary=None;cancelled=False
 try:
  (root/'preclosure.json').write_text(json.dumps(verify(spec_path)))
  # Exact tools and private HOME; native settings cannot leak into selected 0/16/32 modes.
  env={k:v for k,v in os.environ.items() if not k.startswith(('TMUX','NODE_')) and k not in ['BUN_OPTIONS']}
  env.update(HOME=s['cleanHome'],PATH=str(pathlib.Path(s['node']).parent)+':/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL='en_US.UTF-8',TZ='UTC',PYTHONDONTWRITEBYTECODE='1')
  with (root/'campaign.log').open('xb') as log:
   child=subprocess.Popen(command(s),stdout=log,stderr=subprocess.STDOUT,cwd=str(pathlib.Path(s['overlay'])/s['lane']),env=env,start_new_session=True)
   def cancel(signum,frame):
    nonlocal cancelled
    cancelled=True
    if child.poll() is None:child.send_signal(signal.SIGTERM)
   previous={n:signal.signal(n,cancel) for n in [signal.SIGTERM,signal.SIGINT]}
   try:code=child.wait()
   finally:
    for n,h in previous.items():signal.signal(n,h)
  assert code==0 and not cancelled,('Component failed or cancelled',code,cancelled)
  rows=result_rows(s);summary=validate(s,rows)
  (root/'summary.json').write_text(json.dumps(summary,indent=2))
 except BaseException as e:failure=repr(e)
 finally:
  try:post=verify(spec_path);(root/'postclosure.json').write_text(json.dumps(post))
  except BaseException as e:(root/'postclosure-failure.json').write_text(json.dumps({'error':repr(e)}))
  try:rows=result_rows(s)
  except BaseException as e:failure=failure or repr(e)
  expected={'parser':18,'metadata':9,'tail':3}[s['lane']]
  cleanup=bool(rows) and all(r.get('cleanup') and not any('error' in c for c in r['cleanup']) and any(c.get('absenceProved') is True for c in r['cleanup']) for r in rows)
  terminal={'exit':code,'error':failure,'cancelled':cancelled,'postclosure':post is not None,'completedCases':len(rows),'expectedCases':expected,'reportedCasesCleanup':cleanup,'completeOwnedCleanup':len(rows)==expected and cleanup,'passed':failure is None and post is not None and summary is not None and len(rows)==expected and cleanup}
  (root/'terminal.json').write_text(json.dumps(terminal,indent=2))
 if not terminal['passed']:raise SystemExit('Retained failed component lane; no retry')
if __name__=='__main__':run(*sys.argv[1:])
