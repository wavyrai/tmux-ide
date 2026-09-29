"""One build-only preparation: current CLI, unpatched stock, imports/closure. No fixture entry."""
import os,pathlib,json,hashlib,shutil,traceback,time,sys,tarfile
from bounded import run_bounded
from extract_runtime import extract_runtime
from payload import package_payload
from closure import verify
from admit_topology import admit
I=pathlib.Path('/inputs');E=pathlib.Path('/evidence');D=json.loads((I/'admission.json').read_text());code=1;phase='admission';restored=False;post=False;os.umask(0o077)
S=pathlib.Path('/work/current/source');CURRENT=S.parent
ENV={'HOME':'/work/home','PATH':'/opt/node26/bin:/pinned:/usr/bin:/bin','LC_ALL':'C','TZ':'UTC','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_OPTIONAL_LOCKS':'0'}
def sha(p):
 with pathlib.Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def run(name,args,cwd='/work',timeout=180):
 global phase
 phase=name
 with (E/(name+'.log')).open('xb') as log:r=run_bounded(args,cwd=str(cwd),env=ENV,output=log,timeout=timeout,limit=32*1024*1024)
 (E/(name+'-status.json')).write_text(json.dumps({'exit':r.returncode,'truncated':r.truncated,'bytes':r.bytes}))
 assert r.returncode==0 and not r.truncated,name
 return (E/(name+'.log')).read_text()
def git(name,args,cwd=S):return run(name,['/usr/bin/git',*args],cwd)
try:
 assert os.uname().machine=='x86_64' and D['preparationOnly'] is True
 assert D['imageId']==os.environ['APPROVED_IMAGE_ID'] and D['runnerImageVersion']==os.environ['APPROVED_RUNNER_IMAGE_VERSION']
 assert {p.name:sha(p) for p in I.iterdir() if p.name!='admission.json'}==D['inputHashes']
 for p,h in D['imageToolHashes'].items():assert sha(p)==h,p
 assert D['source']['commit']=='be8bcfad29610265716b8dcb657658cf8f1d0ba3'
 assert sha(I/'runtime.tar.gz')==D['runtimeArchive']['sha256']
 assert sha(I/'source.bundle')==D['source']['bundleSha256'] and sha(I/'upstream.bundle')==D['upstream']['bundleSha256']
 first=admit(D['cpuset']);(E/'topology-before.json').write_text(json.dumps(first,indent=2))
 phase='extract';scratch=pathlib.Path('/work/runtime-extracted');proof=extract_runtime(I/'runtime.tar.gz',scratch)
 for p in scratch.iterdir():assert not (pathlib.Path('/work')/p.name).exists();p.rename(pathlib.Path('/work')/p.name)
 scratch.rmdir();(E/'runtime-extraction.json').write_text(json.dumps(proof))
 ledger=json.loads((I/'full-closure.json').read_text());(E/'closure-before.json').write_text(json.dumps(verify('/work',ledger)));restored=True
 assert json.loads(pathlib.Path('/work/artifact-receipt.json').read_text())==json.loads((I/'artifact-receipt.json').read_text())
 base=json.loads(pathlib.Path('/work/artifact-receipt.json').read_text())
 for p,digest in base['closure'].items():assert sha(p)==digest,p
 CURRENT.mkdir();pathlib.Path('/work/home').mkdir(mode=0o700)
 assert os.getuid()>0
 git('source-clone',['clone','--no-checkout',str(I/'source.bundle'),str(S)],CURRENT)
 git('source-checkout',['checkout','--detach',D['source']['commit']])
 assert git('source-head',['rev-parse','HEAD']).strip()==D['source']['commit']
 assert git('source-tree',['rev-parse','HEAD^{tree}']).strip()==D['source']['tree']
 assert not (S/'.git/objects/info/alternates').exists()
 # Existing Linux dependency installation copied as bytes, never installed/rebuilt.
 tracked=git('source-files',['ls-files','-z']).split('\0');manifests=[p for p in tracked if p.endswith('package.json')]
 copied=[]
 for rel in sorted({str(pathlib.Path(p).parent/'node_modules') for p in manifests}):
  source=pathlib.Path('/work/source')/rel;target=S/rel
  if source.is_dir():
   assert not source.is_symlink();shutil.copytree(source,target,symlinks=True,copy_function=shutil.copy2);copied.append(rel)
 assert 'node_modules' in copied
 for rel in copied:
  original=pathlib.Path('/work/source')/rel
  for p in original.rglob('*'):
   q=S/rel/p.relative_to(original)
   if p.is_symlink():assert os.readlink(p)==os.readlink(q) and q.resolve(strict=True).is_relative_to(S)
   elif p.is_file():assert sha(p)==sha(q)
 (E/'dependency-copy.json').write_text(json.dumps({'roots':copied,'bytesVerified':True,'allResolvedTargetsInsideCurrentSource':True}))
 extract_runtime(I/'coherence-source.tar',CURRENT/'coherence')
 for lane in ['native','stock']:
  os.symlink('../../source',CURRENT/'coherence'/lane/'source')
  # Bare workspace imports resolve against the exact private current checkout.
  os.symlink('../../source/node_modules',CURRENT/'coherence'/lane/'node_modules')
 process_host={'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'clockTicksPerSecond':int(run('clock-ticks',['/usr/bin/getconf','CLK_TCK']).strip()),'getconf':{'path':'/usr/bin/getconf','sha256':sha('/usr/bin/getconf')}}
 (CURRENT/'process-host.json').write_text(json.dumps(process_host,indent=2))
 # Import graph before expensive stock build; source driver itself is NOT imported.
 run('coherence-import',['/opt/node26/bin/node','--import',str(S/'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs'),'/inputs/import-coherence.mjs'],S)
 run('coherence-tests',['/opt/node26/bin/node','--import',str(S/'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs'),'--test',str(CURRENT/'coherence/linux-identity.test.mjs'),str(CURRENT/'coherence/native/overlay.test.mjs'),str(CURRENT/'coherence/native/partial-allocation.test.ts'),str(CURRENT/'coherence/stock/overlay.test.mjs'),str(CURRENT/'coherence/stock/partial-allocation.test.ts'),str(CURRENT/'coherence/stock/collect-stock.test.mjs'),str(CURRENT/'coherence/stock/semantic-oracle.test.mjs'),str(CURRENT/'coherence/stock/stock-admission.test.mjs')],S)
 run('cli-build',['/pinned/bun',str(S/'scripts/build-cli.mjs'),'--outfile',str(S/'.tasks/coherence-cli/cli.mjs'),'--metafile',str(S/'.tasks/coherence-cli/cli-metafile.json')],S)
 run('cli-version',['/opt/node26/bin/node',str(S/'.tasks/coherence-cli/cli.mjs'),'--version'],S,30)
 assert git('source-clean-after-build',['status','--porcelain','--untracked-files=all']).strip()==''
 git('source-self-contained',['fsck','--full','--no-reflogs'])
 git('upstream-clone',['clone','--no-checkout',str(I/'upstream.bundle'),'/work/stock-upstream'],CURRENT)
 git('upstream-checkout',['checkout','--detach',D['upstream']['commit']],'/work/stock-upstream')
 assert git('upstream-tree',['rev-parse','HEAD^{tree}'],'/work/stock-upstream').strip()==D['upstream']['tree']
 git('stock-source-archive',['archive','--format=tar','--output='+str(CURRENT/'stock-source.tar'),D['upstream']['commit']],'/work/stock-upstream')
 extract_runtime(CURRENT/'stock-source.tar',CURRENT/'stock-source')
 run('stock-autogen',['/bin/sh','autogen.sh'],CURRENT/'stock-source')
 run('stock-configure',['./configure','--enable-utf8proc','--disable-jemalloc'],CURRENT/'stock-source')
 run('stock-build',['/usr/bin/make','-j','2'],CURRENT/'stock-source',600)
 (CURRENT/'stock').mkdir();shutil.copy2(CURRENT/'stock-source/tmux',CURRENT/'stock/tmux');shutil.copy2(CURRENT/'stock-source/COPYING',CURRENT/'stock/COPYING')
 assert run('stock-version',[str(CURRENT/'stock/tmux'),'-V'],CURRENT,30).strip()=='tmux 3.7c'
 (E/'stock-source.json').write_text(json.dumps({'commit':D['upstream']['commit'],'tree':D['upstream']['tree'],'archiveSha256':sha(CURRENT/'stock-source.tar'),'patches':[],'configure':['--enable-utf8proc','--disable-jemalloc'],'jobs':2,'binarySha256':sha(CURRENT/'stock/tmux')}))
 # Preserve source archive/configuration but omit regenerable compilation tree.
 for name in ['config.log','config.status','Makefile']:shutil.copy2(CURRENT/'stock-source'/name,CURRENT/'stock'/name)
 shutil.rmtree(CURRENT/'stock-source')
 (CURRENT/'preparation-inputs').mkdir()
 for p in I.iterdir():
  if p.is_file() and p.suffix not in ['.tar','.gz','.bundle']:shutil.copy2(p,CURRENT/'preparation-inputs'/p.name)
 run('coherence-collect',['/opt/node26/bin/node','/inputs/collect-coherence.mjs'],S,300)
 phase='package';proof=package_payload(pathlib.Path('/work'),['current','native'],E/'coherence-runtime.tar',pathlib.Path('/work/coherence-roundtrip'))
 assert proof['gitIncluded'];(E/'payload-proof.json').write_text(json.dumps(proof))
 (E/'coherence-archive.json').write_text(json.dumps({'sha256':sha(E/'coherence-runtime.tar'),'bytes':(E/'coherence-runtime.tar').stat().st_size,'roundtripVerified':True}))
 code=0
except BaseException:
 try:(E/'private-build-failure.txt').write_text(traceback.format_exc())
 except BaseException:pass
finally:
 try:
  if restored:
   (E/'closure-after.json').write_text(json.dumps(verify('/work',ledger)))
   assert admit(D['cpuset'])==first
   post=True
 except BaseException:
  code=1;(E/'post-verification-failure.txt').write_text(traceback.format_exc())
 (E/'coherence-build-result.json').write_text(json.dumps({'exit':code,'phase':phase,'postClosurePassed':post,'performanceQualified':False,'fixturesStarted':False}))
sys.exit(code)
