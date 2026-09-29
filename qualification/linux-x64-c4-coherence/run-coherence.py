"""Fixed native then stock 2/4/8 correctness cases; immutable artifact, no builds."""
import os,pathlib,json,hashlib,traceback,time,sys,tarfile,math
from bounded import run_bounded
from extract_runtime import extract_runtime
from coherence_contract import admission,validate_report,SOURCE
from fresh_process_host import bind,require_closed_campaign
from admit_topology import admit
import subprocess
I=pathlib.Path('/inputs');E=pathlib.Path('/evidence');PINS=json.loads((I/'pins.json').read_text());require_closed_campaign(PINS);D=json.loads((I/'descriptor.json').read_text());os.umask(0o077)
code=1;phase='admission';post=None;receipt=None;before_modes=None;fresh=None;fresh_sha=None

def sha(path):
 with pathlib.Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def verify():
 assert sha(I/'coherence-receipt.json')==D['portable']['artifactReceiptSha256']
 for name,h in D['portable']['inputHashes'].items():assert sha(I/name)==h,name
 modes={}
 for name,h in receipt['closure'].items():
  p=pathlib.Path(name);assert p.is_file() and not p.is_symlink();assert sha(p)==h,name;modes[name]=p.stat().st_mode
 for name,expected in receipt['links'].items():
  p=pathlib.Path(name);assert p.is_symlink() and os.readlink(p)==expected['target'] and str(p.resolve(strict=True))==expected['resolved'],name
 if before_modes is not None:assert modes==before_modes
 if fresh_sha is not None:assert sha(E/'fresh-process-host.json')==fresh_sha
 return modes
def run(name,args,lane=None,timeout=900):
 home=E/('home-'+(lane or 'preflight'));home.mkdir(mode=0o700,exist_ok=True)
 binary='/work/native' if lane=='native' else '/work/current/stock'
 env={'HOME':str(home),'XDG_STATE_HOME':str(home/'state'),'XDG_CONFIG_HOME':str(home/'config'),'XDG_CACHE_HOME':str(home/'cache'),'PATH':binary+':/opt/node26/bin:/usr/bin:/bin','LC_ALL':'C','TZ':'UTC','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_OPTIONAL_LOCKS':'0'}
 with (E/(name+'.log')).open('xb') as f:r=run_bounded(args,cwd=SOURCE,env=env,output=f,timeout=timeout,limit=32*1024*1024)
 (E/(name+'-status.json')).write_text(json.dumps({'exit':r.returncode,'truncated':r.truncated,'bytes':r.bytes}));assert r.returncode==0 and not r.truncated,name
try:
 assert D['portable']['lane']=='coherence-native-stock'
 assert sha(I/'frozen-coherence.json')==D['portable']['expectedSpecSha256'];spec=json.loads((I/'frozen-coherence.json').read_text());assert spec['order']==['native','stock'] and spec['clients']==[2,4,8] and spec['recordsPerCase']==500 and spec['resizesPerCase']==20
 assert sha(I/'coherence-runtime.tar')==D['portable']['runtimeTarSha256']==PINS['runtimeArchiveSha256']
 assert sha(I/'coherence-receipt.json')==D['portable']['artifactReceiptSha256']==PINS['artifactReceiptSha256']
 receipt=json.loads((I/'coherence-receipt.json').read_text())
 assert D['imageId']==os.environ['APPROVED_IMAGE_ID'] and D['runnerImageVersion']==os.environ['APPROVED_RUNNER_IMAGE_VERSION']
 assert os.uname().machine=='x86_64' and os.getuid()>0
 first=admit(D['cpuset']);(E/'topology-before.json').write_text(json.dumps(first,indent=2))
 phase='extract';scratch=pathlib.Path('/work/coherence-extracted');proof=extract_runtime(I/'coherence-runtime.tar',scratch)
 for p in scratch.iterdir():assert not (pathlib.Path('/work')/p.name).exists();p.rename(pathlib.Path('/work')/p.name)
 scratch.rmdir();(E/'extraction.json').write_text(json.dumps(proof))
 # Preserve archived timestamp caches, never regenerate or exclude artifact bytes.
 with tarfile.open(I/'coherence-runtime.tar') as tf:
  for m in tf.getmembers():
   if m.isfile():
    p=pathlib.Path('/work')/m.name;assert p.is_file() and not p.is_symlink() and math.isfinite(m.mtime);os.utime(p,(m.mtime,m.mtime),follow_symlinks=False)
 phase='pre-closure';before_modes=verify();(E/'pre-closure.json').write_text(json.dumps({'passed':True,'files':len(before_modes)}))
 assert receipt['cliSha256']==PINS['cliSha256'] and receipt['stock']['binarySha256']==PINS['stockSha256']
 observed={'platform':'linux','arch':'x64','bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'clockTicksPerSecond':int(subprocess.check_output(['/usr/bin/getconf','CLK_TCK'],text=True)),'getconf':{'path':'/usr/bin/getconf','sha256':sha('/usr/bin/getconf')}}
 fresh=bind(receipt,observed,PINS['artifactReceiptSha256'])
 (E/'fresh-process-host.json').write_text(json.dumps(fresh,indent=2))
 fresh_sha=sha(E/'fresh-process-host.json')
 (E/'runtime-binding.json').write_text(json.dumps({'freshHostSha256':sha(E/'fresh-process-host.json'),'archiveReceiptSha256':PINS['artifactReceiptSha256'],'hostAdmission':first,'containerPidNamespace':os.readlink('/proc/self/ns/pid'),'source':SOURCE,'runtimeArchiveSha256':PINS['runtimeArchiveSha256']},indent=2))
 for lane in ['native','stock']:
  phase=lane
  descriptor=E/(lane+'-admission.json');descriptor.write_text(json.dumps(admission(receipt,lane,D['portable']['artifactReceiptSha256'],fresh),indent=2));os.chmod(descriptor,0o600)
  # The driver is unchanged and owns its original assertions, diagnostics and cleanup.
  run(lane,['/opt/node26/bin/node','--import',SOURCE+'/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs','/work/current/coherence/'+lane+'/coherence-canonical.ts',str(E/lane),str(descriptor)],lane)
  report=json.loads((E/lane/'report.json').read_text());assert (E/lane/'complete.json').is_file()
  (E/(lane+'-gate.json')).write_text(json.dumps(validate_report(report,lane)))
 code=0
except BaseException:
 code=1
 try:(E/'private-coherence-failure.txt').write_text(traceback.format_exc())
 except BaseException:pass
finally:
 if before_modes is not None:
  try:verify();post=True
  except BaseException:
   post=False;code=1
   (E/'post-closure-failure.txt').write_text(traceback.format_exc())
  (E/'post-closure.json').write_text(json.dumps({'passed':post}))
 try:
  assert admit(D['cpuset'])==first
  if fresh is not None:
   assert pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()==fresh['processHost']['bootId']
 except BaseException:code=1
 (E/'coherence-lane-result.json').write_text(json.dumps({'exit':code,'phase':phase,'postClosurePassed':post,'performanceQualified':False,'scope':'be8/default0 original native and stock2/4/8'}))
sys.exit(code)
