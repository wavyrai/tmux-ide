"""One original parser18 workload from two frozen archives; no build or retries."""
import json,os,pathlib,shutil,subprocess,tarfile,traceback
from bounded import run_bounded
from closure import sha,verify
from admit_topology import admit
from cpu_environment import capture
from overlay_times import restore_overlay_times
P=pathlib.Path;I=P('/inputs');E=P('/evidence');W=P('/work');NODE='/opt/node26/bin/node';H=W/'source/.tasks/native-x64-c4/harness';T=W/'source/.tasks/components-linux';LANE=T/'parser'
os.umask(0o077);D=json.loads((I/'admission.json').read_text());ledger=json.loads((I/'full-closure.json').read_text());restored=False;code=1;stage='admission';before=None;component=None
ENV={'HOME':'/evidence/home-parser','PATH':'/opt/node26/bin:/pinned:/usr/bin:/bin','LC_ALL':'C','TZ':'UTC'}
def run(name,args,timeout=300,extra=None):
 global stage
 stage=name;env={**ENV,**(extra or {})}
 with (E/(name+'.log')).open('xb') as f:r=run_bounded(args,cwd='/work/source',env=env,timeout=timeout,limit=32*1024*1024,output=f)
 (E/(name+'-status.json')).write_text(json.dumps({'exit':r.returncode,'truncated':r.truncated,'bytes':r.bytes}))
 assert r.returncode==0 and not r.truncated,name
try:
 assert D['lane']=='parser18' and D['budgets']['retries']==0
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
 assert not T.exists();T.mkdir();assert sha(I/'component-overlay.tar')==D['componentOverlay']['sha256']
 with tarfile.open(I/'component-overlay.tar') as tf:
  members=tf.getmembers();assert len(members)==67
  for m in members:assert (m.isfile() or m.isdir()) and not P(m.name).is_absolute() and '..' not in P(m.name).parts
  tf.extractall(T,filter='fully_trusted')
 (E/'overlay-timestamps.json').write_text(json.dumps(restore_overlay_times(I/'component-overlay.tar',T)))
 component=json.loads((I/'component-receipt.json').read_text())
 for p,h in component['closure'].items():assert sha(p)==h,p
 base=json.loads((W/'artifact-receipt.json').read_text());assert base==json.loads((I/'artifact-receipt.json').read_text());assert base['cliSha256']==D['cliSha256'];base['reviewed']=True;base['reviewBasis']='Parent accepted CLI36589727232 and component36597548371 artifacts; raw receipts remain immutable.'
 reviewed=E/'reviewed-base.json';reviewed.write_text(json.dumps(base,indent=2))
 artifact=json.loads((W/'host-inputs.json').read_text())['artifact'];runtime={'bootId':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'clockTicksPerSecond':int(subprocess.check_output(['/usr/bin/getconf','CLK_TCK'],text=True)),'cgroupPath':first['cgroupPath']}
 (E/'fresh-host-inputs.json').write_text(json.dumps({'artifact':artifact,'runtime':runtime}));(E/'component-host.json').write_text(json.dumps({**artifact,**runtime}));(E/'home-parser').mkdir(mode=0o700)
 shutil.copy2(I/'lane-verify.mjs',LANE/'verify.mjs');(LANE/'reference.json').write_text(json.dumps({'binary':'/work/native-grid-reference/tmux','sha256':D['referenceSha256']}))
 # Reuse admitted actual-native import and explicit fresh identity validation; no fixture starts.
 run('component-import',[NODE,'/inputs/import-components.mjs'])
 run('parser-import',[NODE,'--input-type=module','-e',"await import('file:///work/source/.tasks/components-linux/parser/comparative.mjs')"])
 for p,h in component['closure'].items():assert sha(p)==h,p
 run('base-freeze',[NODE,str(H/'prepare-freeze.mjs'),'/evidence/fresh-host-inputs.json',str(reviewed),'cpu','/evidence/base-spec.json','/evidence/unused-base-output'])
 run('parser-freeze',[NODE,'/inputs/freeze-parser.mjs'])
 run('preflight',[NODE,'/inputs/verify-components.mjs'])
 before=capture(E/'environment-before.json');assert all(v==0 for a in before['ancestors'] for v in a['throttling'].values())
 shutil.copy2(LANE/'source-at-prepare.json',E/'parser-source-at-start.json')
 run('parser',[NODE,str(LANE/'echo.mjs'),'/work/native/tmux',str(E/'parser-results'),'qualification'],600)
 run('parser-gate',['/usr/bin/python3','/inputs/gate-parser.py'])
 code=0
except BaseException:
 (E/'failure.txt').write_text(traceback.format_exc())
finally:
 attempt_stage=stage;post=False
 try:
  if restored:
   (E/'closure-after.json').write_text(json.dumps(verify(W,ledger,allow_component=True)))
   if component is not None:
    for p,h in component['closure'].items():assert sha(p)==h,p
   if (E/'frozen-parser.json').exists():
    run('post-closure',[NODE,'/inputs/verify-components.mjs'])
    shutil.copy2(LANE/'source-at-prepare.json',E/'parser-source-at-end.json')
   assert admit(D['cpuset'])==first
   if before is not None:assert capture(E/'environment-after.json')==before
   post=True
 except BaseException:
  code=1;(E/'post-verification-failure.txt').write_text(traceback.format_exc())
 try:
  output=E/'parser-results'
  if output.exists():
   total=0;count=0
   for p in output.rglob('*'):
    assert not p.is_symlink()
    if p.is_file():count+=1;total+=p.stat().st_size
   assert count<=512 and total<=64*1024*1024
  if (LANE/'source-at-prepare.json').is_file():shutil.copy2(LANE/'source-at-prepare.json',E/'source-at-prepare.json')
  dest=E/'private-fixture-diagnostics';dest.mkdir(exist_ok=True)
  for root in P('/tmp').glob('tmux-attribution-perf-*'):
   assert root.is_dir() and not root.is_symlink()
   for p in root.iterdir():
    if p.is_file() and not p.is_symlink():
     with p.open('rb') as f:data=f.read(65537)
     (dest/(root.name+'-'+p.name)).write_bytes(data[:65536])
 except BaseException:
  code=1;(E/'retention-failure.txt').write_text(traceback.format_exc())
 (E/'parser-lane-result.json').write_text(json.dumps({'exit':code,'stage':attempt_stage,'postClosurePassed':post,'performanceQualified':False,'scope':D['scope']}))
raise SystemExit(code)
