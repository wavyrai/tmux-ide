"""CI preparation only; one image and one exact-owned container, no performance lane."""
import pathlib,os,json,subprocess,hashlib,uuid,sys,traceback
from bounded import run_bounded
P=pathlib.Path;Q=P(__file__).resolve().parent;checkout=Q.parents[1];temp=P(os.environ['RUNNER_TEMP']);E=temp/'x64-c4-inputs';W=temp/'x64-c4-work'
E.mkdir(mode=0o700);W.mkdir(mode=0o700);nonce=uuid.uuid4().hex;name='tmux-ide-x64-inputs-'+nonce;cid=None;image=None
os.umask(0o077)
def sha(p):
 h=hashlib.sha256()
 with P(p).open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def run(name,args,timeout=60):
 with (E/(name+'.log')).open('xb') as log:r=run_bounded(args,timeout=timeout,limit=32*1024*1024,output=log)
 (E/(name+'-status.json')).write_text(json.dumps({'exit':r.returncode,'truncated':r.truncated,'bytes':r.bytes}))
 assert r.returncode==0 and not r.truncated,name
 return (E/(name+'.log')).read_text().strip()
def docker(args,timeout=60):return subprocess.check_output(['/usr/bin/docker','--host','unix:///var/run/docker.sock',*args],text=True,timeout=timeout).strip()
def owned():
 x=json.loads(docker(['inspect',cid]))[0];assert x['Id']==cid and x['Name']=='/'+name and x['Image']==image and x['Config']['Labels']['tmux-ide.x64-inputs']==nonce;return x
try:
 host={'ImageOS':os.environ.get('ImageOS'),'ImageVersion':os.environ.get('ImageVersion'),'runnerArch':os.environ.get('RUNNER_ARCH'),'runId':os.environ.get('GITHUB_RUN_ID'),'runAttempt':os.environ.get('GITHUB_RUN_ATTEMPT'),'workflowSha':os.environ.get('GITHUB_SHA'),'uname':list(os.uname()),'bootId':P('/proc/sys/kernel/random/boot_id').read_text().strip(),'selfCgroup':P('/proc/self/cgroup').read_text(),'dockerSha256':sha('/usr/bin/docker'),'affinity':sorted(os.sched_getaffinity(0))}
 assert host['runnerArch']=='X64' and os.uname().machine=='x86_64'
 host['cpuTopology']={str(c):{n:(P('/sys/devices/system/cpu')/('cpu'+str(c))/'topology'/n).read_text().strip() for n in ['core_id','physical_package_id','thread_siblings_list']} for c in host['affinity']}
 raw=host['selfCgroup'].strip();assert raw.startswith('0::/') and '\n' not in raw
 root=P('/sys/fs/cgroup');current=root.joinpath(*P(raw[3:]).parts[1:]);host['cgroupAncestors']=[]
 while True:
  host['cgroupAncestors'].append({'path':str(current),**{n:(current/n).read_text().strip() if (current/n).exists() else None for n in ['cpu.max','cpu.stat','cpuset.cpus.effective']}})
  if current==root:break
  assert current.is_relative_to(root);current=current.parent
 (E/'host.json').write_text(json.dumps(host,indent=2));run('lscpu',['/usr/bin/lscpu','--json']);run('docker-version',['/usr/bin/docker','--host','unix:///var/run/docker.sock','version','--format','{{json .}}']);run('docker-info',['/usr/bin/docker','--host','unix:///var/run/docker.sock','info','--format','{{json .}}'])
 run('image-build',['/usr/bin/docker','--host','unix:///var/run/docker.sock','build','--platform','linux/amd64','--iidfile',str(E/'image-id.txt'),str(Q)],1200)
 image=(E/'image-id.txt').read_text().strip();imageData=json.loads(docker(['image','inspect',image]));assert imageData[0]['Architecture']=='amd64';(E/'image-inspect.json').write_text(json.dumps(imageData,indent=2));run('image-history',['/usr/bin/docker','--host','unix:///var/run/docker.sock','history','--no-trunc',image])
 (E/'owned-intent.json').write_text(json.dumps({'name':name,'nonce':nonce,'image':image}))
 cid=docker(['create','--name',name,'--label','tmux-ide.x64-inputs='+nonce,'--init','--cgroupns=host','--memory','6g','--pids-limit','512','--user',str(os.getuid())+':'+str(os.getgid()),'--mount','type=bind,src='+str(checkout/'candidate-source')+',dst=/inputs/source,readonly','--mount','type=bind,src='+str(temp/'x64-upstream')+',dst=/inputs/upstream,readonly','--mount','type=bind,src='+str(Q)+',dst=/qualification,readonly','--mount','type=bind,src='+str(W)+',dst=/work','--mount','type=bind,src='+str(E)+',dst=/evidence',image,'/usr/bin/python3','/qualification/build-inputs.py'])
 (E/'container-id.txt').write_text(cid+'\n');(E/'container-before.json').write_text(json.dumps(owned(),indent=2));docker(['start',cid]);status=docker(['wait',cid],2100);(E/'container-exit.txt').write_text(status+'\n');assert status=='0'
 # Exact final image is a retained artifact, never pushed to a registry.
 run('image-save',['/usr/bin/docker','--host','unix:///var/run/docker.sock','image','save','--output',str(E/'prep-image.tar'),image],300)
 run('image-compress',['/usr/bin/gzip','-1',str(E/'prep-image.tar')],300)
except BaseException:
 (E/'runner-failure.txt').write_text(traceback.format_exc());raise
finally:
 if cid:
  x=owned();(E/'container-before-cleanup.json').write_text(json.dumps(x,indent=2))
  try:run('container-log',['/usr/bin/docker','--host','unix:///var/run/docker.sock','logs','--tail','100',cid])
  finally:
   owned();docker(['rm','--force',cid]);assert docker(['ps','-a','--no-trunc','--filter','id='+cid,'--format','{{.ID}}'])==''
   (E/'cleanup.json').write_text(json.dumps({'containerId':cid,'name':name,'nonce':nonce,'absenceConfirmed':True}))
 if image:
  assert json.loads(docker(['image','inspect',image]))[0]['Id']==image;docker(['image','rm',image])
 (E/'artifact-hashes.json').write_text(json.dumps({p.name:sha(p) for p in sorted(E.iterdir()) if p.is_file() and p.name!='artifact-hashes.json'},indent=2))
