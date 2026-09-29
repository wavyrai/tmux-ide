"""Consume one verified input artifact; run only the separately reviewed offline CLI preparation."""
import os,pathlib,json,hashlib,subprocess,zipfile,tarfile,shutil,sys,traceback
from bounded import run_bounded
P=pathlib.Path;Q=P(__file__).resolve().parent;ROOT=Q.parents[1];T=P(os.environ['RUNNER_TEMP']);I=T/'x64-cli-inputs';E=T/'x64-cli-evidence';W=T/'x64-cli-work';C=T/'x64-verified-artifact';D=json.loads((Q/'pins.json').read_text());imageLoaded=False
I.mkdir(mode=0o700);C.mkdir(mode=0o700)
def sha(p):
 h=hashlib.sha256()
 with P(p).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def run(name,args,cwd=None,timeout=60,output=None):
 log=output or C/('runner-'+name+'.log')
 with log.open('xb') as out:r=run_bounded(args,cwd=cwd,timeout=timeout,limit=32*1024*1024,output=out)
 assert r.returncode==0 and not r.truncated,name
 return log.read_text().strip()
def archive(source,target):
 with tarfile.open(target,'w',dereference=False) as tf:
  for p in sorted(source.iterdir()):tf.add(p,arcname=p.name)
def extract_store(path,target):
 target.mkdir()
 with tarfile.open(path) as tf:
  members=tf.getmembers();assert len(members)<200000
  for m in members:assert not P(m.name).is_absolute() and '..' not in P(m.name).parts and (m.isfile() or m.isdir()),m.name
  tf.extractall(target)
try:
 assert os.environ['ImageVersion']==D['runnerImageVersion'];assert os.uname().machine=='x86_64'
 assert sha(D['dockerPath'])==D['dockerSha256'],'Docker client pin changed'
 # New runner identity is recorded; old boot/cgroup fields are never copied.
 (C/'fresh-runner.json').write_text(json.dumps({'ImageVersion':os.environ['ImageVersion'],'bootId':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'cgroup':P('/proc/self/cgroup').read_text(),'affinity':sorted(os.sched_getaffinity(0)),'workflowSha':os.environ['GITHUB_SHA']},indent=2))
 artifact=C/'artifact.zip'
 with artifact.open('xb') as out:
  subprocess.run(['gh','api','repos/wavyrai/tmux-ide/actions/artifacts/'+str(D['inputArtifact']['id'])+'/zip'],stdout=out,check=True,timeout=300)
 assert artifact.stat().st_size==D['inputArtifact']['bytes'] and sha(artifact)==D['inputArtifact']['sha256']
 with zipfile.ZipFile(artifact) as z:
  hashes=json.loads(z.read('artifact-hashes.json'));assert set(z.namelist())==set(hashes)|{'artifact-hashes.json'}
  for name in z.namelist():
   assert P(name).name==name
   h=hashlib.sha256()
   with z.open(name) as src,(C/name).open('xb') as out:
    for block in iter(lambda:src.read(1024*1024),b''):h.update(block);out.write(block)
   if name in hashes:assert h.hexdigest()==hashes[name],name
 (C/'verified-input-artifact.json').write_text(json.dumps({'runId':D['inputArtifact']['runId'],'sha256':sha(artifact),'allMembersVerified':True}))
 run('load-image',['/usr/bin/docker','--host','unix:///var/run/docker.sock','image','load','--input',str(C/'prep-image.tar.gz')],timeout=180);imageLoaded=True
 inspect=json.loads(run('inspect-loaded-image',['/usr/bin/docker','--host','unix:///var/run/docker.sock','image','inspect',D['imageId']]))[0];assert inspect['Id']==D['imageId'] and inspect['Architecture']=='amd64'
 source=ROOT/'candidate-source';assert run('source-head',['git','rev-parse','HEAD'],str(source))==D['sourceCommit'];assert run('source-tree',['git','rev-parse','HEAD^{tree}'],str(source))==D['sourceTree']
 run('source-bundle',['git','bundle','create',str(I/'source.bundle'),'HEAD'],str(source),180)
 assert sha(Q/'candidate.patch')==D['candidatePatchSha256'];assert {p.name:sha(p) for p in (Q/'harness').iterdir() if p.is_file()}==D['harnessFiles']
 for name in ['prepare.py','admit_topology.py','bounded.py','collect-artifact.mjs','full-closure.mjs','wait4-proof.py','harness-workspaces.mjs','payload.py','host-artifact.json','candidate.patch']:shutil.copy2(Q/name,I/name)
 archive(Q/'harness',I/'harness.tar')
 native=ROOT/'qualification/linux-x64-c4/qualified-native.tar.gz';assert sha(native)==D['nativeArchiveSha256'];shutil.copy2(native,I/'native.tar');shutil.copy2(C/'reference.tar.gz',I/'reference.tar');extract_store(C/'pnpm-store.tar.gz',I/'pnpm-store')
 D['inputHashes']={str(p.relative_to(I)):sha(p) for p in I.rglob('*') if p.is_file()}
 (I/'admission.json').write_text(json.dumps(D,indent=2));shutil.copy2(I/'admission.json',C/'admission.json')
 # Wrapper enforces exact image/nonce ownership, no network/quota, cpuset0,2,
 # fresh host identity and cleanup. It does not invoke a campaign.
 run('offline-cli-preparation',[sys.executable,str(Q/'launch-preparation.py'),str(I/'admission.json'),str(E),str(W)],timeout=1500)
except BaseException:
 (C/'runner-failure.txt').write_text(traceback.format_exc());raise
finally:
 E.mkdir(exist_ok=True)
 retained=E/'input-and-runner-receipts';retained.mkdir(exist_ok=True)
 for p in C.iterdir():
  if p.is_file() and p.suffix in ['.json','.log','.txt']:shutil.copy2(p,retained/p.name)
 if imageLoaded:(E/'loaded-image.json').write_text(json.dumps({'imageId':D['imageId']}))
