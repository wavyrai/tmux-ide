"""CPU admission/freeze; no tmux/CLI/workload. Existing wait4 prerequisite runs before freeze."""
import pathlib,json,sys,subprocess,os
from binding import sha
from stage import once

def supervisor_text(text):
 start=text.index('def verify():');end=text.index('\nverify()',start)
 text=text[:start]+"def verify():\n assert pathlib.Path(sys.argv[2]).read_bytes()==spec_bytes,'Frozen spec changed'\n subprocess.run([spec['python'],spec['verifyScript'],sys.argv[2]],check=True,timeout=300)"+text[end:]
 text=once(text,"import os,sys,json,time,subprocess,pathlib,hashlib","import os,sys,json,time,subprocess,pathlib,hashlib,signal\ncancelled=False\ndef request_stop(signum,frame):\n global cancelled\n cancelled=True\nsignal.signal(signal.SIGTERM,request_stop)\nsignal.signal(signal.SIGINT,request_stop)")
 text=once(text," for mode in order:\n  case="," for mode in order:\n  if cancelled:raise SystemExit('Cancelled before next owned case')\n  case=")
 text=once(text,"if time.monotonic()>=deadline:","if cancelled or time.monotonic()>=deadline:")
 return text

def freeze(binding_path,admission_path,overlay,output):
 binding_path=pathlib.Path(binding_path).resolve();overlay=pathlib.Path(overlay).resolve();output=pathlib.Path(output).resolve();base=pathlib.Path(__file__).resolve().parent
 b=json.loads(binding_path.read_text());assert b['executionAuthorized'] is False;paths=b['paths']
 assert not output.exists();output.mkdir(mode=0o700)
 host=output/'host.json';env=dict(os.environ,LC_ALL='C',TZ='UTC',PYTHONDONTWRITEBYTECODE='1')
 subprocess.run([paths['node'],str(base/'admit-host.mjs'),str(binding_path),str(host)],check=True,timeout=120,env=env)
 with (output/'wait4.log').open('xb') as log:subprocess.run([sys.executable,str(base/'test_wait4_aggregation.py')],stdout=log,stderr=subprocess.STDOUT,check=True,timeout=30,env=env)
 # Preserve existing campaign ordering, wait4 accounting and exact 10% calculations.
 campaign=overlay/'cpu/campaign.py';text=supervisor_text(campaign.read_text())
 import difflib
 (overlay/'campaign-freeze.diff').write_text(''.join(difflib.unified_diff(campaign.read_text().splitlines(True),text.splitlines(True),fromfile='staged/campaign.py',tofile='frozen/campaign.py')))
 campaign.write_text(text)
 home=output/'home';home.mkdir(mode=0o700)
 closure={};links={}
 for root in [base,overlay]:
  for p in root.rglob('*'):
   if '__pycache__' in p.parts:continue
   if p.is_symlink():links[str(p)]=os.readlink(p)
   elif p.is_file():closure[str(p)]=sha(p)
 for p in [binding_path,pathlib.Path(admission_path).resolve(),host,pathlib.Path(sys.executable).resolve()]:closure[str(p)]=sha(p)
 for module in sys.modules.values():
  name=getattr(module,'__file__',None)
  if name and pathlib.Path(name).is_file():
   p=pathlib.Path(name).resolve();closure[str(p)]=sha(p)
 spec={'lane':'cpu','node':paths['node'],'python':str(pathlib.Path(sys.executable).resolve()),'binary':paths['native'],'binarySha256':sha(paths['native']),'referenceBinary':paths['reference'],'referenceSha256':sha(paths['reference']),'cli':paths['cli'],'cliSha256':sha(paths['cli']),'output':str(output/'results'),'cleanHome':str(home),'systemPath':str(pathlib.Path(paths['node']).parent)+':/usr/bin:/bin:/usr/sbin:/sbin','sourceCommit':b['sourceCommit'],'runtimePatch':None,'observerSha256':b['observerSha256'],'verifyScript':str(base/'verify-cpu.py'),'hostReceipt':str(host),'admission':json.loads(pathlib.Path(admission_path).read_text()),'closure':closure,'links':links,'executionAuthorized':False}
 (output/'frozen-cpu.json').write_text(json.dumps(spec,indent=2)+'\n')
 return spec
if __name__=='__main__':freeze(*sys.argv[1:])
