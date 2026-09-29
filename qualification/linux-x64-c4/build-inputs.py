"""One grid-only reference build + dependency preparation; no candidate/native893 launch."""
import pathlib,json,hashlib,shutil,os,sys,tarfile,traceback
from bounded import run_bounded
P=pathlib.Path;Q=P('/qualification');W=P('/work');E=P('/evidence');pins=json.loads((Q/'pins.json').read_text())
os.umask(0o077);env={'HOME':'/work/home','PATH':'/opt/node26/bin:/pinned:/usr/bin:/bin','LC_ALL':'C','TZ':'UTC','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'};stage='admission'
def sha(p):
 h=hashlib.sha256()
 with P(p).open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def run(name,args,cwd='/work',timeout=180):
 global stage
 stage=name
 with (E/(name+'.log')).open('xb') as log:r=run_bounded(args,cwd=cwd,env=env,output=log,timeout=timeout,limit=32*1024*1024)
 (E/(name+'-status.json')).write_text(json.dumps({'exit':r.returncode,'truncated':r.truncated,'bytes':r.bytes}))
 assert r.returncode==0 and not r.truncated,name
 return (E/(name+'.log')).read_text()
def archive(root,destination):
 with tarfile.open(destination,'w:gz',dereference=False) as tf:
  for p in sorted(root.iterdir()):tf.add(p,arcname=p.name)
def ledger(root):
 rows=[]
 for p in [root,*sorted(root.rglob('*'))]:
  s=p.lstat();r={'path':str(p.relative_to(root)),'mode':s.st_mode&0o7777}
  if p.is_symlink():r.update(kind='symlink',target=os.readlink(p))
  elif p.is_file():r.update(kind='file',bytes=s.st_size,sha256=sha(p))
  elif p.is_dir():r.update(kind='directory')
  else:raise AssertionError('special file '+str(p))
  rows.append(r)
 return rows
try:
 assert os.uname().machine=='x86_64';(W/'home').mkdir()
 assert run('node-version',['/opt/node26/bin/node','--version']).strip()=='v26.8.2'
 assert run('bun-version',['/pinned/bun','--version']).strip()=='1.4.2'
 assert run('pnpm-version',['/opt/node26/bin/node','/pinned/pnpm.cjs','--version']).strip()=='10.21.0'
 shutil.copy2('/pinned/dpkg-packages.txt',E/'dpkg-packages-before.txt')
 (E/'apt-sources.json').write_text(json.dumps({str(p):p.read_text() for p in P('/etc/apt').rglob('*') if p.is_file() and p.suffix in ['.sources','.list']},indent=2))
 (E/'container-host.json').write_text(json.dumps({'uname':list(os.uname()),'affinity':sorted(os.sched_getaffinity(0)),'cgroup':P('/proc/self/cgroup').read_text(),'pid1Command':P('/proc/1/comm').read_text(),'bootId':P('/proc/sys/kernel/random/boot_id').read_text().strip()},indent=2))
 assert sha(Q/'qualified-native.tar.gz')==pins['qualifiedNativeArchiveSha256']
 (W/'native').mkdir()
 with tarfile.open(Q/'qualified-native.tar.gz') as tf:
  for m in tf.getmembers():assert not P(m.name).is_absolute() and '..' not in P(m.name).parts and (m.isfile() or m.isdir())
  tf.extractall(W/'native')
 assert sha(W/'native/tmux')=='8933071dbaeea131b04961ab74ff8b21a622891bce6a01f43ef5122e2fad14d2'
 for path,h in pins['nativeReceiptFiles'].items():
  if path.startswith('bundle/'):assert sha(W/'native'/path[7:])==h,path
 for name in ['source','upstream']:
  run(name+'-clone',['/usr/bin/git','clone','--no-checkout','/inputs/'+name,str(W/name)])
  commit=pins['source'] if name=='source' else pins['reference']['upstream']
  run(name+'-checkout',['/usr/bin/git','checkout','--detach',commit],str(W/name))
  assert run(name+'-head',['/usr/bin/git','rev-parse','HEAD'],str(W/name)).strip()==commit
  run(name+'-tree',['/usr/bin/git','rev-parse','HEAD^{tree}'],str(W/name))
 source=W/'source';builder=W/'reference-builder';shutil.copytree(source/'scripts',builder/'scripts');(builder/'native/tmux').mkdir(parents=True)
 provenance=json.loads((source/'native/tmux/provenance.json').read_text());assert provenance['commit']==pins['reference']['upstream']
 provenance['patches']=[p for p in provenance['patches'] if p['patch']=='native-grid.patch'];provenance.pop('experimentalExtensions',None);assert len(provenance['patches'])==1
 (builder/'native/tmux/provenance.json').write_text(json.dumps(provenance,indent=2));shutil.copy2(source/'native/tmux/native-grid.patch',builder/'native/tmux/native-grid.patch')
 assert sha(builder/'native/tmux/native-grid.patch')==pins['reference']['gridPatchSha256']
 shutil.copy2(source/'native/tmux/COPYING',builder/'native/tmux/COPYING')
 assert sha(builder/'native/tmux/COPYING')==pins['referenceRequiredInputs']['native/tmux/COPYING']
 decoder=P('packages/daemon/src/terminal/mirror/native-grid-capture.ts');(builder/decoder).parent.mkdir(parents=True);shutil.copy2(source/decoder,builder/decoder)
 run('reference-input-preflight',['/opt/node26/bin/node','/qualification/reference-preflight.mjs',str(builder),str(Q/'pins.json')],str(builder))
 (E/'reference-builder-inputs.json').write_text(json.dumps(ledger(builder),indent=2))
 run('reference-build',['/opt/node26/bin/node',str(builder/'scripts/build-bundled-tmux.mjs'),'--source',str(W/'upstream'),'--output',str(W/'native-grid-reference'),'--jobs','2'],str(builder),900)
 manifest=json.loads((W/'native-grid-reference/manifest.json').read_text());assert manifest['platform']=='linux' and manifest['arch']=='x64' and len(manifest['patches'])==1 and manifest['patches'][0]['patchSha256']==pins['reference']['gridPatchSha256']
 shutil.copy2(W/'native-grid-reference/manifest.json',E/'reference-manifest.json')
 # These are header/loader-only checks: qualified native893 is never executed.
 for name in ['native','native-grid-reference']:
  path=str(W/name/'tmux')
  run(name+'-elf-header',['/usr/bin/readelf','-h',path]);run(name+'-elf-program',['/usr/bin/readelf','-l',path]);run(name+'-elf-dynamic',['/usr/bin/readelf','-d',path])
  run(name+'-loader',['/lib64/ld-linux-x86-64.so.2','--list',path])
 run('workspace-dependencies',['/opt/node26/bin/node','/pinned/pnpm.cjs','install','--frozen-lockfile','--ignore-scripts','--side-effects-cache=false','--store-dir','/work/pnpm-store'],str(source),900)
 run('source-diff',['/usr/bin/git','diff','--exit-code'],str(source))
 for name,root in [('reference',W/'native-grid-reference'),('pnpm-store',W/'pnpm-store')]:
  (E/(name+'-closure.json')).write_text(json.dumps(ledger(root),indent=2));archive(root,E/(name+'.tar.gz'))
 tools={str(p):sha(p) for p in map(P,['/opt/node26/bin/node','/pinned/bun','/pinned/pnpm.cjs','/usr/bin/python3','/usr/bin/git','/usr/bin/pgrep','/usr/bin/readelf','/usr/bin/getconf','/bin/sh','/usr/bin/env','/lib64/ld-linux-x86-64.so.2'])}
 (E/'tool-hashes.json').write_text(json.dumps(tools,indent=2));shutil.copy2('/pinned/dpkg-packages.txt',E/'dpkg-packages.txt')
 run('clock-ticks',['/usr/bin/getconf','CLK_TCK']);run('compiler-version',['/usr/bin/cc','--version']);run('linker-version',['/usr/bin/ld','--version']);run('libc-version',['/usr/bin/ldd','--version'])
 (E/'runtime-inputs.json').write_text(json.dumps({'referenceSha256':sha(W/'native-grid-reference/tmux'),'nativeSha256':sha(W/'native/tmux'),'tools':tools,'source':pins['source'],'referenceSource':pins['reference'],'performanceQualified':False,'candidateBuilt':False},indent=2))
except BaseException:
 (E/'build-inputs-failure.txt').write_text(traceback.format_exc());raise
finally:
 (E/'stage.json').write_text(json.dumps({'stage':stage,'performanceQualified':False}))
