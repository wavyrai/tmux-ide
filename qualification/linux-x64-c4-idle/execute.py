"""Restore verified bytes, freeze fresh host identity, run once, verify even on failure."""
import json,os,pathlib,shutil,subprocess,tarfile,traceback
from bounded import run_bounded
from closure import sha,verify
from admit_topology import admit
from validate_idle import validate
P=pathlib.Path;I=P('/inputs');E=P('/evidence');W=P('/work');NODE='/opt/node26/bin/node'
os.umask(0o077);D=json.loads((I/'admission.json').read_text());H=W/'source/.tasks/native-x64-c4/harness'
ledger=json.loads((I/'full-closure.json').read_text());restored=False;code=1;stage='admission'
env={'HOME':'/evidence/home','PATH':'/opt/node26/bin:/pinned:/usr/bin:/bin','LC_ALL':'C','TZ':'UTC','PYTHONDONTWRITEBYTECODE':'1'}
def run(name,args,timeout=300):
 global stage
 stage=name
 with (E/(name+'.log')).open('xb') as f:r=run_bounded(args,cwd='/work/source',env=env,timeout=timeout,limit=32*1024*1024,output=f)
 (E/(name+'-status.json')).write_text(json.dumps({'exit':r.returncode,'truncated':r.truncated,'bytes':r.bytes}))
 assert r.returncode==0 and not r.truncated,name
try:
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
  tf.extractall(W,filter='fully_trusted') # Exact accepted archive hash; closure checked before any import.
 (E/'closure-before.json').write_text(json.dumps(verify(W,ledger)));restored=True
 assert {n:sha(H/n) for n in D['harnessFiles']}==D['harnessFiles']
 receipt=json.loads((W/'artifact-receipt.json').read_text());assert receipt==json.loads((I/'artifact-receipt.json').read_text())
 assert receipt['reviewed'] is False and receipt['performanceQualified'] is False and receipt['cliSha256']==D['cliSha256']
 assert receipt['sourceBase']==D['sourceCommit'] and receipt['observationBatchMs']==32 and receipt['nativeDefaultEnabled'] is False
 # Separate review receipt; raw artifact receipt remains immutable.
 receipt['reviewed']=True;receipt['reviewBasis']='Parent accepted CI36589727232 preparation; nested manifest discrepancy explicitly disclosed, original receipt retained.'
 reviewed=E/'reviewed-artifact.json';reviewed.write_text(json.dumps(receipt,indent=2))
 original=json.loads((W/'host-inputs.json').read_text());runtime={'bootId':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'clockTicksPerSecond':int(subprocess.check_output(['/usr/bin/getconf','CLK_TCK'],text=True)),'cgroupPath':first['cgroupPath']}
 host=E/'fresh-host-inputs.json';host.write_text(json.dumps({'artifact':original['artifact'],'runtime':runtime}))
 # Retain original supervisor; only exact cgroup environment observation is overlaid.
 source=(H/'campaign.py').read_text();start=source.index('def throttling():');end=source.index('results=[]',start)
 source=source[:start]+"from cpu_environment import capture\nenvironment_sample=0\ndef throttling():\n global environment_sample\n environment_sample+=1\n return capture(pathlib.Path('/evidence')/f'cpu-environment-{environment_sample}.json')\n"+source[end:]
 source=source.replace("str(HERE/'case.mjs')","str(HERE/'case-idle.mjs')")
 source=source.replace('cumulative ps CPU included.','cumulative Linux /proc CPU included; exact cgroup and ancestor admission sampled before/after each case; host co-tenancy remains unproven.')
 (H/'campaign-idle.py').write_text(source)
 for name in ['cpu_environment.py','admit_topology.py',*D['idleOverlay']]:
  if name in D['idleOverlay']:assert sha(I/name)==D['idleOverlay'][name]
  shutil.copy2(I/name,H/name)
 (E/'campaign-overlay.json').write_text(json.dumps({'originalSha256':sha(H/'campaign.py'),'overlaySha256':sha(H/'campaign-idle.py'),'scope':'One original idle case with accepted Spark final-capture barrier and structured cleanup diagnostics; exact x64 cgroup/ancestor observations.', 'caseBaseSha256':sha(H/'case.mjs'),'caseOverlaySha256':sha(H/'case-idle.mjs'),'helpers':D['idleOverlay']}))
 run('freeze',[NODE,str(H/'prepare-freeze.mjs'),str(host),str(reviewed),'idle','/evidence/frozen-spec.json','/evidence/results-idle'])
 run('campaign',['/usr/bin/python3',str(H/'campaign-idle.py'),'--approved-campaign','/evidence/frozen-spec.json'],600)
 (E/'idle-receipt.json').write_text(json.dumps(validate(E),indent=2))
 code=0
except BaseException:
 (E/'failure.txt').write_text(traceback.format_exc())
finally:
 attempt_stage=stage
 post=False
 try:
  if restored:
   (E/'closure-after.json').write_text(json.dumps(verify(W,ledger,allow_new_harness=True)))
   if (E/'frozen-spec.json').exists():run('verify-after',[NODE,str(H/'verify.mjs'),'/evidence/frozen-spec.json'])
   assert admit(D['cpuset'])==first;post=True
 except BaseException:
  code=1;(E/'post-verification-failure.txt').write_text(traceback.format_exc())
 (E/'campaign-result.json').write_text(json.dumps({'exit':code,'stage':attempt_stage,'postClosurePassed':post,'performanceQualified':False,'scope':D['scope']}))
raise SystemExit(code)
