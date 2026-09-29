"""Acquire only accepted immutable artifacts and launch one reviewed CPU campaign."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,traceback,zipfile
from bounded import run_bounded
P=pathlib.Path;Q=P(__file__).resolve().parent;T=P(os.environ['RUNNER_TEMP']);E=T/'x64-cpu-evidence';I=T/'x64-cpu-inputs';W=T/'x64-cpu-work';R=T/'x64-cpu-downloads'
D=json.loads((Q/'pins.json').read_text());R.mkdir(mode=0o700);I.mkdir(mode=0o700);loaded=False

def sha(p):
 h=hashlib.sha256()
 with P(p).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def acquire(key):
 d=D[key];p=R/(key+'.zip')
 with p.open('xb') as out:subprocess.run(['gh','api','repos/wavyrai/tmux-ide/actions/artifacts/'+str(d['id'])+'/zip'],stdout=out,check=True,timeout=300)
 assert p.stat().st_size==d['bytes'] and sha(p)==d['sha256']
 target=R/key;target.mkdir()
 with zipfile.ZipFile(p) as z:
  names=z.namelist();assert len(names)==len(set(names));ledger=json.loads(z.read('artifact-hashes.json'))
  extra={'artifact-hashes.json'}
  if key=='cliArtifact':extra.add('input-and-runner-receipts/artifact-hashes.json')
  assert set(names)==set(ledger)|extra
  for name in names:
   n=P(name);assert not n.is_absolute() and '..' not in n.parts
   dest=target/n;dest.parent.mkdir(parents=True,exist_ok=True)
   with z.open(name) as src,dest.open('xb') as out:shutil.copyfileobj(src,out,1024*1024)
   if name in ledger:assert sha(dest)==ledger[name],name
  if key=='cliArtifact':assert sha(target/'input-and-runner-receipts/artifact-hashes.json')==D['priorManifestSha256']
 return target
try:
 assert os.environ['GITHUB_RUN_ATTEMPT']=='1','No reruns admitted'
 assert os.environ['ImageVersion']==D['runnerImageVersion'] and os.uname().machine=='x86_64'
 assert sha(D['dockerPath'])==D['dockerSha256']
 (R/'fresh-runner.json').write_text(json.dumps({'bootId':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'cgroup':P('/proc/self/cgroup').read_text(),'affinity':sorted(os.sched_getaffinity(0)),'ImageVersion':os.environ['ImageVersion'],'workflowSha':os.environ['GITHUB_SHA']},indent=2))
 cli=acquire('cliArtifact');inputs=acquire('inputArtifact')
 assert (cli/'input-and-runner-receipts/artifact-hashes.json').read_bytes()==(inputs/'artifact-hashes.json').read_bytes()
 assert sha(cli/'runtime.tar.gz')==D['runtimeArchive']['sha256'] and (cli/'runtime.tar.gz').stat().st_size==D['runtimeArchive']['bytes']
 with (R/'image-load.log').open('xb') as out:
  r=run_bounded([D['dockerPath'],'--host',D['dockerHost'],'image','load','--input',str(inputs/'prep-image.tar.gz')],timeout=180,limit=1048576,output=out)
 assert r.returncode==0 and not r.truncated;loaded=True
 for name in ['runtime.tar.gz','full-closure.json','artifact-receipt.json']:shutil.copy2(cli/name,I/name)
 for name in ['execute.py','bounded.py','admit_topology.py','closure.py','cpu_environment.py']:shutil.copy2(Q/name,I/name)
 D['inputHashes']={p.name:sha(p) for p in I.iterdir()};(I/'admission.json').write_text(json.dumps(D,indent=2))
 with (R/'launch.log').open('xb') as out:
  r=run_bounded([sys.executable,str(Q/'launch.py'),str(I/'admission.json'),str(E),str(W)],timeout=3000,limit=4*1024*1024,output=out)
 assert r.returncode==0 and not r.truncated,'Campaign or cleanup failed; no retry'
except BaseException:
 (R/'runner-failure.txt').write_text(traceback.format_exc());raise
finally:
 E.mkdir(exist_ok=True);retained=E/'runner-receipts';retained.mkdir(exist_ok=True)
 for p in R.iterdir():
  if p.is_file() and p.suffix in ['.json','.log','.txt']:shutil.copy2(p,retained/p.name)
 if (I/'admission.json').exists():shutil.copy2(I/'admission.json',retained/'admission.json')
 if loaded:(E/'loaded-image.json').write_text(json.dumps({'imageId':D['imageId']}))
