"""Held closed stock/native coherence envelope. No build, install, retry or performance claim."""
import pathlib,json,subprocess,sys,os,time,importlib.util,signal
from binding import bind,sha
from stage import stage
HERE=pathlib.Path(__file__).resolve().parent

def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def download(pin,out):
 out.mkdir(mode=0o700)
 for endpoint,name in [(str(pin['artifactId']),'metadata.json'),(str(pin['artifactId'])+'/zip','artifact.zip')]:
  with (out/name).open('xb') as log,(out/(name+'.stderr')).open('xb') as err:
   subprocess.run(['gh','api','repos/wavyrai/tmux-ide/actions/artifacts/'+endpoint],stdout=log,stderr=err,check=True,timeout=1200)
  if name=='metadata.json':
   m=json.loads((out/name).read_text());assert m['id']==pin['artifactId'] and m['workflow_run']['id']==pin['runId'] and not m['expired']
   assert m['size_in_bytes']==pin['zipBytes'] and m['digest']=='sha256:'+pin['zipSha256']
 assert sha(out/'artifact.zip')==pin['zipSha256']
 return out/'artifact.zip'

def run(output):
 pins=json.loads((HERE/'pins.json').read_text());assert pins['executionAuthorized'] is True,'Held recipe: no coherence authorization'
 assert pins['stock'] is not None and pins['lanes']==['stock','native']
 for rel,digest in json.loads((HERE/'recipe-files.json').read_text()).items():assert sha(HERE/rel)==digest,('Recipe changed',rel)
 output=pathlib.Path(output).resolve();assert not output.exists();output.mkdir(mode=0o700);os.umask(0o077)
 status={'ok':False,'singleAttempt':True,'started':time.time(),'performanceClaim':False};rows=[];runtime=stock=None
 try:
  intake=module('coherence_intake',HERE/'upstream-intake-cpu.py').intake
  admitted=[]
  for name,pin in [('runtime',pins),('stock',pins['stock'])]:
   archive=download(pin,output/(name+'-download'));transport=output/(name+'-transport');root=intake(archive,pin,transport)
   admitted.append({'root':str(root),'zip':str(archive),'tar':str(transport/'payload.tar'),'proof':str(transport/'payload-proof.json')})
  runtime,stock=admitted
  b=bind(runtime,stock,pins);(output/'binding.json').write_text(json.dumps(b,indent=2))
  with (output/'host.log').open('xb') as log:
   subprocess.run([b['paths']['node'],str(HERE/'admit-host.mjs'),str(output/'binding.json'),str(output/'host.json')],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=120)
  for mode in pins['lanes']:
   bind(runtime,stock,pins);lane=output/mode;spec=stage(b,mode,lane)
   spec['executionAuthorized']=True;(lane/'command.json').write_text(json.dumps(spec,indent=2));(lane/'command.json').chmod(0o600)
   code=None;post=False
   try:
    with (lane/'supervisor.log').open('xb') as log:
     child=subprocess.Popen([spec['argv'][0],*spec['argv'][1:3],str(lane/'supervise.mjs'),str(lane/'command.json')],cwd=spec['cwd'],env=spec['environment'],stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
     def cancel(signum,frame):
      if child.poll() is None:child.send_signal(signal.SIGTERM)
     old={n:signal.signal(n,cancel) for n in [signal.SIGTERM,signal.SIGINT]}
     try:code=child.wait() # The owned supervisor bounds the whole correctness lane and finalizes resources.
     finally:
      for n,h in old.items():signal.signal(n,h)
   finally:
    try:bind(runtime,stock,pins);post=True
    finally:
     row={'lane':mode,'exit':code,'postclosure':post};rows.append(row);(lane/'terminal.json').write_text(json.dumps(row))
   assert code==0 and post,'Failed lane retained; do not run next lane'
   supervisor=json.loads((lane/'supervisor.json').read_text());assert supervisor['ownedCleanup'] is True
   for n in [2,4,8]:
    case=json.loads((lane/'results'/f'clients-{n}.json').read_text());assert case['count']==n and case['facts'] and not case['failures']
    assert all(case['cleanup'].get(k)=='confirmed' for k in ['observation','pty','daemon','server'])
  status['ok']=True
 finally:
  try:
   if runtime is not None and stock is not None:
    bind(runtime,stock,pins);status['finalFullClosure']=True
  except BaseException as e:
   status['ok']=False;status['finalFullClosure']=False;status['closureError']=repr(e);raise
  finally:
   status.update(finished=time.time(),lanes=rows);(output/'status.json').write_text(json.dumps(status,indent=2))
if __name__=='__main__':run(sys.argv[1])
