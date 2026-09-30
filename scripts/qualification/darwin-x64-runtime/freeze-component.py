"""Prepare original readers then freeze one lane on this admitted host; no fixture launch."""
import pathlib,json,sys,subprocess,os
from binding import sha
LANES=('parser','metadata','tail')
BASE=pathlib.Path(__file__).resolve().parent

def write_descriptors(lane,overlay,output,python,reference):
 assert lane in LANES
 directory=overlay/lane
 (directory/'reference.json').write_text(json.dumps(reference,indent=2)+'\n')
 # Driver entry verifies through the same full original-payload and fresh-host verifier.
 script="import {execFileSync} from 'node:child_process';\nexecFileSync("+json.dumps(python)+","+json.dumps([str(BASE/'verify-cpu.py'),str(output/'frozen-component.json')])+",{stdio:'inherit',timeout:300000});\n"
 (directory/'verify.mjs').write_text(script)
 sources={str(p):sha(p) for p in overlay.rglob('*') if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts}
 (directory/'source-at-prepare.json').write_text(json.dumps({'hashes':sources},indent=2)+'\n')

def freeze(lane,binding_path,admission_path,overlay,output):
 assert lane in LANES
 binding_path=pathlib.Path(binding_path).resolve();overlay=pathlib.Path(overlay).resolve();output=pathlib.Path(output).resolve()
 b=json.loads(binding_path.read_text());assert b['executionAuthorized'] is False and b['runtimePatch'] is None
 assert not output.exists();output.mkdir(mode=0o700);paths=b['paths']
 env=dict(os.environ,LC_ALL='C',TZ='UTC',PYTHONDONTWRITEBYTECODE='1');stages=[]
 def stage(name,argv):
  row={'stage':name,'argv':argv,'exit':None};stages.append(row)
  try:
   with (output/(name+'.log')).open('xb') as log:row['exit']=subprocess.run(argv,stdout=log,stderr=subprocess.STDOUT,env=env,timeout=180).returncode
   assert row['exit']==0,('Preparation stage failed',name,row['exit'])
  finally:(output/'preparation-stages.json').write_text(json.dumps(stages,indent=2))
 host=output/'host.json'
 stage('fresh-host',[paths['node'],str(BASE/'admit-host.mjs'),str(binding_path),str(host)])
 stage('reader-build',[paths['bun'],str(BASE/'build-readers.mjs'),'--prepare-readers',str(binding_path),str(overlay)])
 # Preserve workloads; make process cancellation observable at the next bounded case boundary.
 if lane=='parser':
  p=overlay/lane/'echo.mjs';text=p.read_text();old='  for (const mode of [...modes.slice(round), ...modes.slice(0, round)]) {'
  assert text.count(old)==1;p.write_text(text.replace(old,old+"\n    if (globalThis.qualificationCancelled) throw Error('Qualification cancelled before next case');"))
 python=str(pathlib.Path(sys.executable).resolve())
 write_descriptors(lane,overlay,output,python,{'binary':paths['reference'],'sha256':sha(paths['reference'])})
 closure={};links={}
 for root in [BASE,overlay]:
  for p in root.rglob('*'):
   if '__pycache__' in p.parts:continue
   if p.is_symlink():links[str(p)]=os.readlink(p)
   elif p.is_file():closure[str(p)]=sha(p)
 for p in [binding_path,pathlib.Path(admission_path).resolve(),host,pathlib.Path(python)]:closure[str(p)]=sha(p)
 admission=json.loads(pathlib.Path(admission_path).read_text())
 assert b['dependencyModeDerivation']==admission['derivation']
 for key in ['receipt','ledger']:
  path=pathlib.Path(admission['derivation'][key]);closure[str(path)]=sha(path)
 for module in sys.modules.values():
  name=getattr(module,'__file__',None)
  if name and pathlib.Path(name).is_file():closure[str(pathlib.Path(name).resolve())]=sha(name)
 home=output/'home';home.mkdir(mode=0o700)
 spec={'lane':lane,'node':paths['node'],'python':python,'binary':paths['native'],'binarySha256':sha(paths['native']),'sourceCommit':b['sourceCommit'],'cli':paths['cli'],'cliSha256':sha(paths['cli']),'runtimePatch':None,'output':str(output/'parser-results') if lane=='parser' else str(overlay/lane),'overlay':str(overlay),'cleanHome':str(home),'hostReceipt':str(host),'verifyScript':str(BASE/'verify-cpu.py'),'admission':json.loads(pathlib.Path(admission_path).read_text()),'closure':closure,'links':links,'executionAuthorized':False,'scope':'Original component latency only; CPU diagnostic only'}
 (output/'frozen-component.json').write_text(json.dumps(spec,indent=2)+'\n');return spec
if __name__=='__main__':freeze(*sys.argv[1:])
