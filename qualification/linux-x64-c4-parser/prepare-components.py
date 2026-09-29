"""One offline three-reader build/import. Never executes tmux, CLI, daemon or benchmarks."""
import json,os,pathlib,shutil,subprocess,tarfile,traceback
from bounded import run_bounded
from closure import sha,verify
from admit_topology import admit
from overlay_times import restore_overlay_times
P=pathlib.Path;I=P('/inputs');E=P('/evidence');W=P('/work');NODE='/opt/node26/bin/node';T=W/'source/.tasks/components-linux'
os.umask(0o077);D=json.loads((I/'admission.json').read_text());ledger=json.loads((I/'full-closure.json').read_text());restored=False;code=1;stage='admission'
env={'HOME':'/work/home','PATH':'/opt/node26/bin:/pinned:/usr/bin:/bin','LC_ALL':'C','TZ':'UTC'}
def run(name,args,timeout=300):
 global stage
 stage=name
 with (E/(name+'.log')).open('xb') as f:r=run_bounded(args,cwd='/work/source',env=env,timeout=timeout,limit=32*1024*1024,output=f)
 (E/(name+'-status.json')).write_text(json.dumps({'exit':r.returncode,'truncated':r.truncated,'bytes':r.bytes}))
 assert r.returncode==0 and not r.truncated,name
try:
 assert D['preparationOnly'] is True and os.uname().machine=='x86_64'
 assert D['imageId']==os.environ['APPROVED_IMAGE_ID'] and D['runnerImageVersion']==os.environ['APPROVED_RUNNER_IMAGE_VERSION']
 assert {p.name:sha(p) for p in I.iterdir() if p.name!='admission.json'}==D['inputHashes']
 for p,h in D['imageToolHashes'].items():assert sha(p)==h,p
 first=admit(D['cpuset']);(E/'topology-before.json').write_text(json.dumps(first,indent=2))
 assert sha(I/'runtime.tar.gz')==D['runtimeArchive']['sha256']
 with tarfile.open(I/'runtime.tar.gz') as tf:
  members=tf.getmembers();assert len(members)==91036
  for m in members:
   n=P(m.name);assert not n.is_absolute() and '..' not in n.parts and n.parts[0] in ['source','native','native-grid-reference','host.json','host-inputs.json','artifact-receipt.json']
   assert m.isfile() or m.isdir() or m.issym() or m.islnk()
   if m.issym() or m.islnk():assert not P(m.linkname).is_absolute()
  tf.extractall(W,filter='fully_trusted')
 (E/'closure-before.json').write_text(json.dumps(verify(W,ledger)));restored=True
 assert not T.exists();T.mkdir()
 with tarfile.open(I/'component-source.tar') as tf:
  members=tf.getmembers();assert {m.name for m in members}==set(D['portFiles'])
  for m in members:assert m.isfile() and not P(m.name).is_absolute() and '..' not in P(m.name).parts
  tf.extractall(T,filter='fully_trusted')
 assert {str(p.relative_to(T)):sha(p) for p in T.rglob('*') if p.is_file()}==D['portFiles']
 # Existing pure test body, import path adjusted to its installed sibling common/.
 shutil.copy2(I/'owned-process.test.mjs',T/'owned-process.test.mjs')
 for row in D['matchingReaderInputs']:assert sha(row['path'])==row['x64PreparedSha256']==row['armPreparedSha256']
 base=json.loads((W/'artifact-receipt.json').read_text());assert base==json.loads((I/'artifact-receipt.json').read_text());assert base['cliSha256']==D['cliSha256']
 host=json.loads((W/'host-inputs.json').read_text())['artifact'];host.update(bootId=P('/proc/sys/kernel/random/boot_id').read_text().strip(),clockTicksPerSecond=int(subprocess.check_output(['/usr/bin/getconf','CLK_TCK'],text=True)),cgroupPath=first['cgroupPath'])
 (E/'component-host.json').write_text(json.dumps(host));(W/'home').mkdir(mode=0o700)
 run('component-import',[NODE,'/inputs/import-components.mjs'])
 run('component-tests',['/usr/bin/python3','/inputs/run-component-tests.py'])
 run('overlay-cache-tests',['/usr/bin/python3','/inputs/test_overlay_times.py'])
 run('component-build',['/pinned/bun','/inputs/build-components.mjs'])
 built=json.loads((E/'component-build-inputs.json').read_text());actual={p:h for p,h in built['inputs'].items() if '/.tasks/components-linux/' not in p};expected={r['path']:r['x64PreparedSha256'] for r in D['matchingReaderInputs']};assert actual==expected and len(actual)==132
 run('component-collect',[NODE,'/inputs/collect-components.mjs'])
 receipt=json.loads((E/'component-receipt.json').read_text());assert receipt['reviewed'] is False and receipt['performanceQualified'] is False and receipt['noFixturesStarted'] is True
 for p,h in receipt['closure'].items():assert sha(p)==h,p
 archive=E/'component-overlay.tar'
 with tarfile.open(archive,'x',dereference=False) as tf:
  for p in sorted(T.rglob('*')):
   assert not p.is_symlink();tf.add(p,arcname=str(p.relative_to(T)),recursive=False)
 roundtrip=W/'component-roundtrip';roundtrip.mkdir()
 with tarfile.open(archive) as tf:tf.extractall(roundtrip,filter='fully_trusted')
 restore_overlay_times(archive,roundtrip)
 for p in T.rglob('*'):
  target=roundtrip/p.relative_to(T);assert p.stat().st_mode&0o7777==target.stat().st_mode&0o7777
  if p.is_file():assert sha(p)==sha(target) and int(p.stat().st_mtime)==int(target.stat().st_mtime)
 (E/'component-overlay.json').write_text(json.dumps({'bytes':archive.stat().st_size,'sha256':sha(archive),'roundtripVerified':True,'fileModeAndMtimeVerified':True}))
 code=0
except BaseException:
 (E/'failure.txt').write_text(traceback.format_exc())
finally:
 attempt_stage=stage;post=False
 try:
  if restored:
   (E/'closure-after.json').write_text(json.dumps(verify(W,ledger,allow_component=True)))
   if (E/'component-receipt.json').exists():
    receipt=json.loads((E/'component-receipt.json').read_text())
    for p,h in receipt['closure'].items():assert sha(p)==h,p
   assert admit(D['cpuset'])==first;post=True
 except BaseException:
  code=1;(E/'post-verification-failure.txt').write_text(traceback.format_exc())
 (E/'component-build-result.json').write_text(json.dumps({'exit':code,'stage':attempt_stage,'postClosurePassed':post,'preparationOnly':True,'performanceQualified':False,'scope':D['scope']}))
raise SystemExit(code)
