"""Held Mac Intel CLI-only recipe. No downloads, services, native or stock builds."""
import argparse,pathlib,json,os,platform,shutil,traceback,sys
from admission import ready,sha,contained,unpack,verify_input,COMMIT,TREE
from bounded import run_bounded
from payload import package_payload
HERE=pathlib.Path(__file__).resolve().parent

def prepare(pins_path,archive,payload_receipt,source_checkout,out):
 p=json.loads(pins_path.read_text());ready(p) # MUST precede mutation or command launch.
 for name,h in p['recipeHashes'].items():assert sha(contained(HERE,name))==h
 assert {x.name for x in HERE.iterdir() if x.is_file() and x.suffix in ['.py','.mjs']}<=set(p['recipeHashes'])
 assert sha(archive)==p['inputPayloadSha256'] and sha(payload_receipt)==p['inputPayloadReceiptSha256']
 assert platform.system()=='Darwin' and platform.machine()=='x86_64'
 manifest=json.loads(payload_receipt.read_text());assert manifest['roundtripVerified'] and manifest['sha256']==p['inputPayloadSha256']
 os.umask(0o077);out.mkdir(mode=0o700);(out/'logs').mkdir();(out/'home').mkdir();(out/'tmp').mkdir();stages=[];phase='extract';success=False
 env={'HOME':str(out/'home'),'TMPDIR':str(out/'tmp'),'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C','TZ':'UTC','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_OPTIONAL_LOCKS':'0'}
 def run(name,args,cwd=None,timeout=120):
  nonlocal phase;phase=name
  with (out/'logs'/f'{name}.log').open('xb') as f:r=run_bounded(args,cwd=str(cwd or out),env=env,timeout=timeout,limit=16*1024**2,output=f)
  stages.append({'stage':name,'argv':args,'cwd':str(cwd or out),'exit':r.returncode,'truncated':r.truncated});assert r.returncode==0 and not r.truncated,name
  return (out/'logs'/f'{name}.log').read_text().strip()
 try:
  admitted=out/'admitted';unpack(archive,admitted,manifest['members']);verify_input(admitted,manifest['members']);paths=json.loads((admitted/'payload-path-map.json').read_text());assert paths['rebindRequired']
  tool={k:contained(admitted,v).resolve(strict=True) for k,v in paths['tools'].items()}
  for name,key in [('node','actualNodeExecutableSha256'),('bun','actualBunExecutableSha256'),('pnpm','actualPnpmEntrySha256')]:assert sha(tool[name])==p[key]
  native=contained(admitted,paths['native']);reference=contained(admitted,paths['reference']);assert sha(native)==p['retainedNativeSha256'] and sha(reference)==p['gridReferenceSha256']
  env['PATH']=str(tool['node'].parent)+':'+str(tool['bun'].parent)+':/usr/bin:/bin:/usr/sbin:/sbin'
  translated=run('translation',['/usr/sbin/sysctl','-in','sysctl.proc_translated']);assert translated in ('','0') # -i permits absent key on native Intel; explicit1 refuses Rosetta.
  assert json.loads(run('node-platform',[str(tool['node']),'-p','JSON.stringify([process.platform,process.arch,process.version])']))==['darwin','x64','v26.8.2']
  assert run('bun-version',[str(tool['bun']),'--version'])=='1.4.2'
  assert run('pnpm-version',[str(tool['node']),str(tool['pnpm']),'--version'])=='10.21.0'
  run('host',['/usr/bin/uname','-a']);run('os',['/usr/bin/sw_vers']);run('boot',['/usr/sbin/sysctl','-n','kern.boottime']);run('sdk',['/usr/bin/xcrun','--show-sdk-path'])
  source=out/'source';run('source-clone',['/usr/bin/git','clone','--no-hardlinks',str(source_checkout),str(source)]);run('source-checkout',['/usr/bin/git','checkout','--detach',COMMIT],source)
  assert run('source-commit',['/usr/bin/git','rev-parse','HEAD'],source)==COMMIT and run('source-tree',['/usr/bin/git','rev-parse','HEAD^{tree}'],source)==TREE
  assert (source/'.git').is_dir() and not (source/'.git/objects/info/alternates').exists()
  for name in ['pnpm-lock.yaml','pnpm-workspace.yaml','package.json']:
   assert sha(source/name)==sha(contained(admitted,paths['source'])/name)
  assert sha(source/'packages/daemon/src/lib/native-tmux-interaction-observer.ts')==p['observerSourceSha256']
  store=out/'private-store';shutil.copytree(contained(admitted,paths['offlineStore']),store,symlinks=True)
  run('offline-deps',[str(tool['node']),str(tool['pnpm']),'install','--offline','--frozen-lockfile','--ignore-scripts','--side-effects-cache=false','--store-dir',str(store)],source,600)
  run('native-addon-import',[str(tool['node']),'-e',"const {createRequire}=require('node:module');const r=createRequire(process.cwd()+'/packages/daemon/package.json');if(typeof r('node-pty').spawn!=='function')throw Error('node-pty unavailable');for(const p of ['ws','zod','hono'])r(p);console.log(JSON.stringify(process.report.getReport().sharedObjects));"],source)
  run('cli-build',[str(tool['bun']),str(source/'scripts/build-cli.mjs'),'--outfile',str(source/'.tasks/qualified-cli/cli.mjs'),'--metafile',str(source/'.tasks/qualified-cli/cli-metafile.json')],source,120)
  run('cli-version',[str(tool['node']),str(source/'.tasks/qualified-cli/cli.mjs'),'--version'],source)
  assert not run('source-clean',['/usr/bin/git','status','--porcelain'],source);run('git-self-contained',['/usr/bin/git','fsck','--full','--no-reflogs'],source)
  host_tools={}
  for name in ['/usr/bin/git','/bin/ps','/usr/bin/pgrep','/usr/bin/otool','/usr/bin/sw_vers','/usr/bin/which','/usr/bin/xcrun','/usr/sbin/sysctl',sys.executable]:
   resolved=pathlib.Path(name).resolve(strict=True);host_tools[name]={'resolved':str(resolved),'sha256':sha(resolved)}
  compiler=pathlib.Path(run('compiler',['/usr/bin/xcrun','--find','clang'])).resolve(strict=True);host_tools['compiler']={'resolved':str(compiler),'sha256':sha(compiler)}
  python_modules={str(pathlib.Path(m.__file__).resolve()):sha(pathlib.Path(m.__file__).resolve()) for m in tuple(sys.modules.values()) if getattr(m,'__file__',None) and pathlib.Path(m.__file__).is_file()}
  (out/'host-tools.json').write_text(json.dumps({'tools':host_tools,'loadedPythonModules':python_modules,'scope':'Actual preparation host tools/modules; fresh campaign host must rebind/revalidate, OS shared cache remains explicit.'},indent=2))
  recipe=out/'recipe';shutil.copytree(HERE,recipe,ignore=shutil.ignore_patterns('__pycache__'));binding={**p,**{k:str(v) for k,v in tool.items()},'native':str(native),'reference':str(reference)};(out/'binding.json').write_text(json.dumps(binding,indent=2))
  run('collect',[str(tool['node']),str(recipe/'collect.mjs'),str(out),str(out/'binding.json')],source)
  verify_input(admitted,manifest['members']);assert sha(native)==p['retainedNativeSha256']
  phase='payload';proof=package_payload(out,['source','admitted','recipe','binding.json','cli-receipt.json','host-tools.json'],out/'cli-runtime.tar',out/'roundtrip');(out/'payload-proof.json').write_text(json.dumps(proof));shutil.rmtree(out/'roundtrip')
  (out/'archive.json').write_text(json.dumps({'sha256':sha(out/'cli-runtime.tar'),'bytes':(out/'cli-runtime.tar').stat().st_size,'roundtripVerified':True}));success=True
 except BaseException:(out/'failure.txt').write_text(traceback.format_exc());raise
 finally:(out/'preparation-result.json').write_text(json.dumps({'ok':success,'phase':phase,'stages':stages,'fixturesStarted':False,'performanceQualified':False},indent=2))
if __name__=='__main__':
 a=argparse.ArgumentParser()
 for n in ['pins','archive','payload-receipt','source-checkout','output']:a.add_argument('--'+n,required=True,type=pathlib.Path)
 x=a.parse_args();prepare(x.pins,x.archive,x.payload_receipt,x.source_checkout,x.output)
