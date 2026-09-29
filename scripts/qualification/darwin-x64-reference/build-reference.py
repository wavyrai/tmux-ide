"""Review candidate: build grid reference against original Intel bottle headers/retained libs.
No instrumented tmux build or execution. Requires admitted/extracted input payload and upstream checkout.
"""
import argparse,hashlib,importlib.util,json,os,pathlib,platform,shutil,sys
sys.dont_write_bytecode=True
from macho_identity import inspect
HERE=pathlib.Path(__file__).resolve().parent
DEPS={'utf8proc':('2.11.3','libutf8proc.3.2.3.dylib','libutf8proc.dylib'),
      'libevent':('2.1.13','libevent_core-2.1.7.dylib','libevent_core.dylib'),
      'ncurses':('6.6','libncursesw.6.dylib','libncursesw.dylib')}
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def extract_bottle(helper, archive, prefix, name, version, receipt):
 assert sha(archive)==receipt['sha256']
 extracted=prefix/(name+'-archive')
 helper.unpack_tar(archive,extracted)
 keg=extracted/name/version
 for header,record in receipt['members'].items():
  if '/include/' in header or '/lib/pkgconfig/' in header:assert sha(extracted/header)==record['sha256']
 return keg

def admit_payload_files(inputs, payload, closure):
 admitted={relative:record['sha256'] for relative,record in payload.items() if record['kind']=='file' and relative.startswith(('source/','pnpm-store/','qualified-native/'))}
 missing=sorted(relative for relative in admitted if relative not in closure['hashes'])
 assert all(closure['hashes'][relative]==digest for relative,digest in admitted.items() if relative in closure['hashes']),'Legacy closure overlap mismatch'
 assert all((inputs/relative).is_file() and sha(inputs/relative)==digest for relative,digest in admitted.items()),'Payload bytes mismatch'
 return admitted,{'admittedFileCount':len(admitted),'legacyOverlapCount':len(admitted)-len(missing),'legacyNonoverlapCount':len(missing),'legacyNonoverlapPaths':missing,'authoritativeInventory':'accepted-payload-manifest'}

def main():
 p=argparse.ArgumentParser()
 for name in ['inputs','upstream','output','payload-manifest','assets']:p.add_argument('--'+name,required=True)
 args=p.parse_args();assets=pathlib.Path(args.assets).resolve();inputs=pathlib.Path(args.inputs).resolve();upstream=pathlib.Path(args.upstream).resolve();out=pathlib.Path(args.output).resolve()
 assert platform.system()=='Darwin' and platform.machine()=='x86_64'
 assert not out.exists();out.mkdir(mode=0o700);os.umask(0o077)
 sys.path.insert(0,str(inputs/'recipe'))
 spec=importlib.util.spec_from_file_location('input_recipe',inputs/'recipe/prepare-inputs.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
 from bounded import run_bounded
 pins=json.loads((inputs/'recipe/pins.json').read_text());closure=json.loads((inputs/'input-closure.json').read_text())
 assert closure['source']==pins['sourceCommit'] and closure['tree']==pins['sourceTree']
 native=inputs/'qualified-native/bundle';native_manifest=json.loads((native/'manifest.json').read_text())
 assert sha(native/'manifest.json')==pins['nativeArtifact']['manifestSha256']
 for name,value in native_manifest['files'].items():assert sha(native/name)==value
 node=inputs/'tools/node'/pins['downloads']['node']['root']/pins['downloads']['node']['executable']
 pnpm=inputs/'tools/pnpm'/pins['downloads']['pnpm']['root']/pins['downloads']['pnpm']['executable']
 for tool in [node,pnpm]:assert sha(tool)==closure['hashes'][str(tool.relative_to(inputs))]
 for name in ['home','tmp','logs']: (out/name).mkdir()
 env={'PATH':str(node.parent)+':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(out/'home'),'TMPDIR':str(out/'tmp'),'LC_ALL':'C','TZ':'UTC','DEVELOPER_DIR':'/Applications/Xcode_16.4.app/Contents/Developer'}
 payload=json.loads(pathlib.Path(args.payload_manifest).read_text())['members']
 assert payload['input-closure.json']['sha256']==sha(inputs/'input-closure.json')
 admitted,overlap=admit_payload_files(inputs,payload,closure)
 (out/'legacy-closure-overlap.json').write_text(json.dumps(overlap,indent=2))
 def unchanged():return all((inputs/relative).is_file() and sha(inputs/relative)==digest for relative,digest in admitted.items())
 assert unchanged()
 stages=[];success=False
 def run(name,argv,cwd=None,timeout=60):
  with (out/'logs'/f'{name}.log').open('xb') as log:result=run_bounded([str(x) for x in argv],cwd=cwd,env=env,timeout=timeout,limit=8*1024**2,output=log)
  stages.append({'stage':name,'code':result.returncode,'truncated':result.truncated});(out/'stages.json').write_text(json.dumps(stages,indent=2))
  assert result.returncode==0 and not result.truncated
  return (out/'logs'/f'{name}.log').read_text()
 try:
  assert 'Xcode 16.4' in run('xcode',['/usr/bin/xcodebuild','-version'])
  run('sdk',['/usr/bin/xcrun','--show-sdk-path'])
  assert 'clang-1700.0.13.5' in run('compiler',['/usr/bin/clang','--version'])
  assert run('upstream',['git','-C',upstream,'rev-parse','HEAD']).strip()==pins['upstream']
  if not shutil.which('automake',path=env['PATH']):
   archive=assets/'automake-1.18.1.tar.xz';assert sha(archive)=='168aa363278351b89af56684448f525a5bce5079d0b6842bd910fdd3f1646887'
   helper.unpack_tar(archive,out/'automake-source');source=out/'automake-source/automake-1.18.1'
   run('automake-configure',['/bin/sh','configure','--prefix='+str(out/'automake')],source,120)
   run('automake-build',['/usr/bin/make','-j','2'],source,180)
   run('automake-install',['/usr/bin/make','install'],source,120)
   env['PATH']=str(out/'automake/bin')+':'+env['PATH']
  env['ACLOCAL_PATH']='/usr/local/share/aclocal'
  build_tools={}
  for name in ['autoconf','automake','aclocal','pkg-config','make','git']:
   path=shutil.which(name,path=env['PATH']);assert path
   build_tools[name]={'path':path,'resolved':str(pathlib.Path(path).resolve()),'sha256':sha(pathlib.Path(path).resolve()),'version':run('tool-'+name,[path,'--version'])}
  (out/'build-tools.json').write_text(json.dumps(build_tools,indent=2))
  bottles=json.loads((HERE/'bottle-receipt.json').read_text());identities=json.loads((HERE/'library-identity.json').read_text())
  prefix=out/'dependencies';prefix.mkdir();kegs=[]
  for name,(version,library,linkname) in DEPS.items():
   archive=assets/(name+'.bottle.tar.gz');assert sha(archive)==bottles[name]['sha256']
   identity=identities[name];assert identity['uuidEqual'] and identity['sectionsEqual']
   assert identity['nativeLibrarySha256']==native_manifest['files']['lib/'+library]
   keg=extract_bottle(helper,archive,prefix,name,version,bottles[name]);kegs.append(keg)
   # Only these private copied libraries are modified for link-time absolute IDs.
   target=keg/'lib'/library;target.unlink();shutil.copy2(native/'lib'/library,target)
   run('link-id-'+name,['/usr/bin/install_name_tool','-id',str(target),target])
   run('link-sign-'+name,['/usr/bin/codesign','--force','--sign','-',target])
   alias=keg/'lib'/linkname
   if alias.is_symlink() or alias.exists():alias.unlink()
   alias.symlink_to(library)
   shutil.copy2(native/'licenses'/f'{library}.txt',keg/'COPYING')
   for pc in (keg/'lib/pkgconfig').glob('*.pc'):
    data=pc.read_text().replace('@@HOMEBREW_CELLAR@@',str(keg.parent.parent));assert '@@HOMEBREW' not in data;pc.write_text(data)
  env['PKG_CONFIG_LIBDIR']=':'.join(str(keg/'lib/pkgconfig') for keg in kegs)
  recipe=out/'reference-recipe';shutil.copytree(inputs/'source',recipe,symlinks=True)
  store=out/'pnpm-store';shutil.copytree(inputs/'pnpm-store',store,symlinks=True)
  run('offline-dependencies',[node,pnpm,'install','--offline','--frozen-lockfile','--ignore-scripts','--side-effects-cache=false','--store-dir',store],recipe,600)
  provenance=recipe/'native/tmux/provenance.json';data=json.loads(provenance.read_text())
  assert data['commit']==pins['upstream'] and sha(recipe/'native/tmux/native-grid.patch')==pins['gridPatch']
  data['patches']=[x for x in data['patches'] if x['patch']=='native-grid.patch'];assert len(data['patches'])==1;data['experimentalExtensions']=[];provenance.write_text(json.dumps(data,indent=2))
  run('build-reference',[node,recipe/'scripts/build-bundled-tmux.mjs','--source',upstream,'--output',out/'bundle','--jobs','2'],timeout=600)
  reference=json.loads((out/'bundle/manifest.json').read_text());assert reference['patches']==data['patches'] and not reference.get('experimentalExtensions',[])
  # Confirm normal builder relocation before installing the admitted exact signed bytes.
  assert set(p.name for p in (out/'bundle/lib').iterdir())=={x[1] for x in DEPS.values()}
  linked=run('reference-loads',['/usr/bin/otool','-L',out/'bundle/tmux'])
  for _,(_,library,_) in DEPS.items():
   assert '@executable_path/lib/'+library+' (compatibility' in linked
   generated=out/'bundle/lib'/library;retained=native/'lib'/library
   assert inspect(generated.read_bytes())==inspect(retained.read_bytes()),'Generated dependency code/build identity differs'
   assert run('library-id-'+library,['/usr/bin/otool','-D',generated]).splitlines()[1]=='@loader_path/'+library
   shutil.copy2(retained,generated)
   reference['files']['lib/'+library]=sha(generated)
   run('verify-signature-'+library,['/usr/bin/codesign','--verify',generated])
  (out/'bundle/manifest.json').write_text(json.dumps(reference,indent=2)+'\n')
  run('verify-reference-signature',['/usr/bin/codesign','--verify',out/'bundle/tmux'])
  roots=out/'mach-roots.json';roots.write_text(json.dumps([str(out/'bundle/tmux')]))
  run('mach-closure',[node,inputs/'recipe/mach-inputs.mjs',roots,out/'mach-closure.json'])
  for name,value in native_manifest['files'].items():assert sha(native/name)==value
  assert unchanged()
  success=True
 finally:
  try:run('processes-after',['/bin/ps','-axo','pid=,ppid=,stat=,lstart=,command='])
  finally:
   intact=unchanged()
   (out/'status.json').write_text(json.dumps({'ok':success and intact,'admittedInputsUnchanged':intact,'performanceQualified':False,'functionalLiveTestsPending':True},indent=2))
   assert intact,'Admitted inputs changed'
if __name__=='__main__':main()
