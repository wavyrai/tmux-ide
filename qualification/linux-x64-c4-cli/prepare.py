"""Proposed preparation entry only. No native build, server, or performance campaign."""
import pathlib,json,hashlib,os,subprocess,tarfile,shutil,sys,traceback
from bounded import run_bounded
from admit_topology import admit
from payload import package_payload
I=pathlib.Path('/inputs');E=pathlib.Path('/evidence');W=pathlib.Path('/work')
os.umask(0o077)
D=json.loads((I/'admission.json').read_text());stage='admission'
def sha(p):
 h=hashlib.sha256()
 with pathlib.Path(p).open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
NODE='/opt/node26/bin/node';BUN='/pinned/bun'
env={'HOME':'/work/home','PATH':'/opt/node26/bin:/pinned:/usr/bin:/bin','LC_ALL':'C','TZ':'UTC','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}
def run(name,argv,cwd='/work',timeout=120):
 global stage
 stage=name
 with (E/(name+'.log')).open('xb') as log:r=run_bounded(argv,cwd=cwd,env=env,output=log,timeout=timeout,limit=32*1024*1024)
 (E/(name+'-status.json')).write_text(json.dumps({'exit':r.returncode,'truncated':r.truncated,'bytes':r.bytes}))
 assert r.returncode==0 and not r.truncated,name
 return (E/(name+'.log')).read_text()
def extract(name,dest):
 dest.mkdir()
 with tarfile.open(I/name) as tf:
  members=tf.getmembers();assert len(members)<10000
  for m in members:
   p=pathlib.PurePosixPath(m.name);assert not p.is_absolute() and '..' not in p.parts and (m.isfile() or m.isdir())
  tf.extractall(dest)
try:
 assert D['preparationApproved'] is True and D['performanceApproved'] is False
 assert D['sourceCommit']=='cb6f09efb173d045d2bc221d0f14cfe415075b48'
 assert D['imageId']==os.environ['APPROVED_IMAGE_ID'] and D['imageId'].startswith('sha256:')
 assert D['runnerImageVersion']==os.environ['APPROVED_RUNNER_IMAGE_VERSION']
 topology=admit(D['cpuset']);(E/'topology.json').write_text(json.dumps(topology,indent=2))
 assert D['inputHashes'] and len(D['inputHashes'])>10
 for p in I.rglob('*'):
  if p.is_symlink():assert p.resolve().is_relative_to(I),str(p)
 actual={str(p.relative_to(I)):sha(p) for p in I.rglob('*') if p.is_file() and p!=I/'admission.json'}
 assert actual==D['inputHashes'],'Input closure differs'
 for p,h in D['imageToolHashes'].items():assert sha(p)==h,p
 assert all(p in D['imageToolHashes'] for p in [NODE,BUN,'/pinned/pnpm.cjs','/usr/bin/python3','/usr/bin/git','/usr/bin/pgrep','/usr/bin/readelf','/usr/bin/getconf','/bin/sh','/usr/bin/env'])
 (W/'home').mkdir()
 assert run('node-version',[NODE,'--version']).strip()=='v26.8.2'
 assert run('bun-version',[BUN,'--version']).strip()=='1.4.2'
 assert run('pnpm-version',[NODE,'/pinned/pnpm.cjs','--version']).strip()=='10.21.0'
 run('source-clone',['/usr/bin/git','clone','--no-checkout','/inputs/source.bundle','/work/source'])
 run('source-checkout',['/usr/bin/git','checkout','--detach',D['sourceCommit']],'/work/source')
 assert run('source-tree',['/usr/bin/git','rev-parse','HEAD^{tree}'],'/work/source').strip()==D['sourceTree']
 run('candidate-patch',['/usr/bin/git','apply','/inputs/candidate.patch'],'/work/source')
 diff=run('candidate-diff',['/usr/bin/git','diff','--binary'],'/work/source');assert hashlib.sha256(diff.encode()).hexdigest()==D['candidateDiffSha256']
 for path,digest in D['candidateChangedFiles'].items():assert sha(W/'source'/path)==digest,path
 harness=W/'source/.tasks/native-x64-c4/harness';harness.parent.mkdir(parents=True);extract('harness.tar',harness)
 assert {f.name:sha(f) for f in harness.iterdir() if f.is_file()}==D['harnessFiles']
 extract('native.tar',W/'native');extract('reference.tar',W/'native-grid-reference')
 assert sha(W/'native/tmux')=='8933071dbaeea131b04961ab74ff8b21a622891bce6a01f43ef5122e2fad14d2'
 assert sha(W/'native-grid-reference/tmux')==D['referenceSha256']
 for name in ['native','native-grid-reference']:
  m=json.loads((W/name/'manifest.json').read_text());assert m['arch']=='x64' and m['platform']=='linux' and m['commit']=='e476c1230b958df0cb12977517d24b3dc931375b'
  patches=m['patches'];assert patches[0]['patchSha256']=='b0bedabf8e2bd055662f796609b8e8b9a8c8746c6f2a655b0d017872d4827f4f'
  assert len(patches)==(2 if name=='native' else 1)
  for f,h in m['files'].items():assert sha(W/name/f)==h
 shutil.copytree(I/'pnpm-store',W/'pnpm-store',symlinks=True)
 run('offline-dependencies',[NODE,'/pinned/pnpm.cjs','install','--offline','--frozen-lockfile','--ignore-scripts','--side-effects-cache=false','--store-dir','/work/pnpm-store'],'/work/source',600)
 run('harness-workspaces',[NODE,'/inputs/harness-workspaces.mjs','/work/source',str(harness)],'/work/source')
 artifact=json.loads((I/'host-artifact.json').read_text());assert artifact['containerImage']==D['imageId']
 paths={'node':NODE,'bun':BUN,'python':'/usr/bin/python3','pgrep':'/usr/bin/pgrep','readelf':'/usr/bin/readelf','getconf':'/usr/bin/getconf','sh':'/bin/sh','env':'/usr/bin/env'}
 for name,path in paths.items():assert artifact['tools'][name]['path']==path and artifact['tools'][name]['sha256']==D['imageToolHashes'][path]
 assert artifact['native']['path']=='/work/native/tmux' and artifact['reference']['path']=='/work/native-grid-reference/tmux'
 assert artifact['reference']['sha256']==D['referenceSha256']
 runtime={'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'clockTicksPerSecond':int(run('clock-ticks',['/usr/bin/getconf','CLK_TCK']).strip()),'cgroupPath':topology['cgroupPath']}
 host={**artifact,**runtime};(W/'host.json').write_text(json.dumps(host));(W/'host-inputs.json').write_text(json.dumps({'artifact':artifact,'runtime':runtime}))
 run('cli-build',[NODE,str(harness/'build.mjs'),'/work/host.json'],'/work/source',180)
 run('case-import',[NODE,str(harness/'import-check.mjs')],'/work/source')
 run('wait4-proof',['/usr/bin/python3','/inputs/wait4-proof.py',NODE],'/work/source')
 run('collect-artifact',[NODE,'/inputs/collect-artifact.mjs'],'/work/source',300)
 run('full-closure',[NODE,'/inputs/full-closure.mjs'],'/work/source',300)
 assert admit(D['cpuset'])==topology
 for f in ['host.json','host-inputs.json']:shutil.copy2(W/f,E/f)
 proof=package_payload(W,['source','native','native-grid-reference','host.json','host-inputs.json','artifact-receipt.json'],E/'runtime.tar',W/'roundtrip')
 (E/'payload-proof.json').write_text(json.dumps(proof))
 run('compress-runtime',['/usr/bin/gzip','-1',str(E/'runtime.tar')],timeout=300)
 (E/'runtime-archive.json').write_text(json.dumps({'sha256':sha(E/'runtime.tar.gz'),'bytes':(E/'runtime.tar.gz').stat().st_size,'performanceQualified':False}))
 for f in ['build-receipt.json','cli-metafile.json']:shutil.copy2(harness/f,E/f)
 (E/'preparation-result.json').write_text(json.dumps({'passed':True,'reviewed':False,'performanceQualified':False,'requiresIndependentFullClosureReview':True}))
except BaseException:
 (E/'failure.txt').write_text(traceback.format_exc());(E/'preparation-result.json').write_text(json.dumps({'passed':False,'stage':stage,'performanceQualified':False}));raise
