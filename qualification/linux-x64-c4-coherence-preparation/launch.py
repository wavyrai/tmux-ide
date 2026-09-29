"""One approved coherence preparation in one exact-owned container. Build-only; no live fixtures or retry."""
import pathlib,json,subprocess,os,sys,uuid,hashlib
from bounded import run_bounded
from validate_receipts import validate_preparation_receipts
admission=pathlib.Path(sys.argv[1]).resolve();d=json.loads(admission.read_text());e=pathlib.Path(sys.argv[2]).resolve();w=pathlib.Path(sys.argv[3]).resolve()
assert not e.exists() and not w.exists();e.mkdir(mode=0o700);w.mkdir(mode=0o700)
assert d['preparationOnly'] is True
assert os.environ['ImageVersion']==d['runnerImageVersion'],'Runner image version changed; new admission required'
docker=d['dockerPath'];assert hashlib.sha256(pathlib.Path(docker).read_bytes()).hexdigest()==d['dockerSha256']
config=e/'docker-config';config.mkdir(mode=0o700);env={'PATH':'/usr/bin:/bin','HOME':str(e),'DOCKER_CONFIG':str(config)}
base=[docker,'--host',d['dockerHost']];nonce=uuid.uuid4().hex;name='tmux-ide-x64-coherence-prep-'+nonce;cid=None
label='tmux-ide.private-coherence-preparation='+nonce

def call(args,timeout=30):
 r=run_bounded(base+args,env=env,timeout=timeout,limit=2*1024*1024)
 assert r.returncode==0 and not r.truncated,(args,r.stdout)
 return r.stdout.strip()
def owned():
 x=json.loads(call(['inspect',cid]))[0]
 assert x['Id']==cid and x['Name']=='/'+name and x['Image']==d['imageId'] and x['Config']['Labels']['tmux-ide.private-coherence-preparation']==nonce
 assert x['HostConfig']['NanoCpus']==0 and x['HostConfig']['CpuQuota']==0 and x['HostConfig']['CpusetCpus']==d['cpuset']
 assert x['HostConfig']['Init'] is True and x['HostConfig']['CgroupnsMode']=='host'
 assert x['HostConfig']['NetworkMode']=='none' and x['HostConfig']['PidMode']=='' and x['HostConfig']['Privileged'] is False
 assert x['HostConfig']['Memory']==4294967296 and x['HostConfig']['PidsLimit']==256
 assert {(m['Destination'],m['Source'],m['RW']) for m in x['Mounts']}=={('/inputs',str(admission.parent),False),('/work',str(w),True),('/evidence',str(e),True)}
 return x
try:
 image=json.loads(call(['image','inspect',d['imageId']]))[0];assert image['Id']==d['imageId'] and image['Architecture']=='amd64' and image['Os']=='linux'
 (e/'image-inspect.json').write_text(json.dumps(image,indent=2))
 (e/'owned-intent.json').write_text(json.dumps({'name':name,'nonce':nonce,'image':d['imageId']}))
 cid=call(['create','--pull=never','--name',name,'--label',label,'--init','--network=none','--cgroupns=host','--cpuset-cpus',d['cpuset'],'--memory','4g','--pids-limit','256','--user',str(os.getuid())+':'+str(os.getgid()),'--mount','type=bind,src='+str(admission.parent)+',dst=/inputs,readonly','--mount','type=bind,src='+str(w)+',dst=/work','--mount','type=bind,src='+str(e)+',dst=/evidence','--env','APPROVED_IMAGE_ID='+d['imageId'],'--env','APPROVED_RUNNER_IMAGE_VERSION='+d['runnerImageVersion'],d['imageId'],'/usr/bin/python3','/inputs/prepare-coherence.py'])
 (e/'container-id.txt').write_text(cid+'\n');(e/'container-before.json').write_text(json.dumps(owned(),indent=2))
 call(['start',cid]);result=call(['wait',cid],timeout=1500);(e/'container-exit.txt').write_text(result+'\n');assert result=='0'
 validate_preparation_receipts(e)
finally:
 if cid:
  x=owned();(e/'container-before-cleanup.json').write_text(json.dumps(x,indent=2))
  try:
   (e/'container-log.txt').write_text(call(['logs','--tail','100',cid]))
  finally:
   owned();call(['rm','--force',cid]);remaining=call(['ps','--all','--no-trunc','--filter','id='+cid,'--format','{{.ID}}']);assert remaining==''
   (e/'cleanup.json').write_text(json.dumps({'containerId':cid,'name':name,'nonce':nonce,'exactIdentityChecked':True,'absenceConfirmed':True}))
