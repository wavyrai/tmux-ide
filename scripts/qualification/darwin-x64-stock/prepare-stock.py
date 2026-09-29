"""Review draft: genuine Intel stock preparation only; no server or performance campaign."""
import sys
sys.dont_write_bytecode=True
import argparse,pathlib,platform,os,json,shutil,importlib.util
HERE=pathlib.Path(__file__).resolve().parent

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def classify_host(version,binary):
 if version!='tmux 3.7c':return 'version'
 if binary.parent.name!='bin' or binary.parent.parent.parent!=pathlib.Path('/usr/local/Cellar/tmux'):return 'non-homebrew-path'
 return None

def admit(pins,payload_receipt,reference_recipe):
 import hashlib
 sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 assert pins['executionAuthorized'] is True,'Stock preparation not authorized'
 assert sha(payload_receipt)==pins['inputPayloadReceiptSha256'],'Payload receipt mismatch'
 for relative,digest in pins['recipeHashes'].items():assert sha(HERE/relative)==digest,'Stock recipe mismatch'
 for relative,digest in pins['referenceHelperHashes'].items():assert sha(reference_recipe/relative)==digest,'Reference helper mismatch'

def main():
 parser=argparse.ArgumentParser()
 for name in ['inputs','upstream','assets','output','payload-manifest','reference-recipe']:parser.add_argument('--'+name,required=True)
 args=parser.parse_args();inputs=pathlib.Path(args.inputs).resolve();upstream=pathlib.Path(args.upstream).resolve();assets=pathlib.Path(args.assets).resolve();out=pathlib.Path(args.output).resolve();reference_recipe=pathlib.Path(args.reference_recipe).resolve()
 assert platform.system()=='Darwin' and platform.machine()=='x86_64' and not out.exists()
 stock_pins=json.loads((HERE/'stock-pins.json').read_text());admit(stock_pins,pathlib.Path(args.payload_manifest),reference_recipe)
 out.mkdir(mode=0o700);os.umask(0o077)
 sys.path[:0]=[str(reference_recipe),str(reference_recipe/'ci'),str(inputs/'recipe')]
 reference=load('reference_helpers',reference_recipe/'build-reference.py');helper=load('input_helpers',inputs/'recipe/prepare-inputs.py')
 from bounded import run_bounded
 from admission import verify_input
 manifest=json.loads(pathlib.Path(args.payload_manifest).read_text())['members'];verify_input(inputs,manifest)
 pins=json.loads((inputs/'recipe/pins.json').read_text());assert pins['upstream']==stock_pins['upstream'];native=inputs/'qualified-native/bundle'
 assert reference.sha(native/'manifest.json')==pins['nativeArtifact']['manifestSha256']
 for name in ['home','tmp','logs']:(out/name).mkdir()
 node=inputs/'tools/node'/pins['downloads']['node']['root']/pins['downloads']['node']['executable']
 env={'HOME':str(out/'home'),'TMPDIR':str(out/'tmp'),'PATH':str(node.parent)+':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','DEVELOPER_DIR':'/Applications/Xcode_16.4.app/Contents/Developer','LC_ALL':'C','TZ':'UTC','HOMEBREW_NO_AUTO_UPDATE':'1','HOMEBREW_NO_ANALYTICS':'1'}
 stages=[];ok=False;mode=None
 def run(name,argv,cwd=None,timeout=60):
  with (out/'logs'/f'{name}.log').open('xb') as log:r=run_bounded([str(x) for x in argv],cwd=cwd,env=env,timeout=timeout,limit=8*1024**2,output=log)
  stages.append({'stage':name,'code':r.returncode,'truncated':r.truncated});(out/'stages.json').write_text(json.dumps(stages,indent=2));assert r.returncode==0 and not r.truncated
  return (out/'logs'/f'{name}.log').read_text()
 try:
  assert 'clang-1700.0.13.5' in run('compiler',['/usr/bin/clang','--version'])
  run('sdk',['/usr/bin/xcrun','--show-sdk-path'])
  compiler=pathlib.Path(run('compiler-path',['/usr/bin/xcrun','--find','clang']).strip());tool_receipt={'compiler':{'path':str(compiler),'sha256':reference.sha(compiler)}}
  for name in ['git','make','autoconf','pkg-config']:
   tool=shutil.which(name,path=env['PATH']);assert tool
   tool_receipt[name]={'path':tool,'sha256':reference.sha(pathlib.Path(tool).resolve()),'version':run('tool-'+name,[tool,'--version'])}
  (out/'build-tools.json').write_text(json.dumps(tool_receipt,indent=2))
  candidate=shutil.which('tmux',path=env['PATH']);host={'present':candidate is not None,'admitted':False}
  (out/'host-stock.json').write_text(json.dumps(host,indent=2))
  if candidate:
   binary=pathlib.Path(candidate).resolve();host.update(path=candidate,resolved=str(binary),sha256=reference.sha(binary),version=run('host-version',[binary,'-V']).strip())
   (out/'host-stock.json').write_text(json.dumps(host,indent=2))
   # Only recorded official Homebrew3.7c is a candidate; capabilities remain a later owned-server gate.
   ineligible=classify_host(host['version'],binary)
   tab=binary.parent.parent/'INSTALL_RECEIPT.json';license=binary.parent.parent/'COPYING'
   if ineligible:host['ineligibleReason']=ineligible
   elif not tab.is_file() or not license.is_file():host['ineligibleReason']='missing-provenance-or-license'
   else:
    host['receiptSha256']=reference.sha(tab);host['receipt']=json.loads(tab.read_text())
    formula=json.loads(run('host-formula',['/usr/local/bin/brew','info','--json=v2','--installed','tmux']))['formulae'];host['formula']=formula
    if len(formula)==1 and formula[0]['name']=='tmux' and formula[0]['tap']=='homebrew/core':host['admitted']=True;mode='host-stock';source=binary
    else:host['ineligibleReason']='non-official-formula'
  (out/'host-stock.json').write_text(json.dumps(host,indent=2))
  if mode is None:
   mode='unpatched-source';assert run('upstream',['/usr/bin/git','-C',upstream,'rev-parse','HEAD']).strip()==pins['upstream']
   if not shutil.which('automake',path=env['PATH']):
    archive=assets/'automake-1.18.1.tar.xz';assert reference.sha(archive)=='168aa363278351b89af56684448f525a5bce5079d0b6842bd910fdd3f1646887'
    helper.unpack_tar(archive,out/'automake-source');reference.restore_source_mtimes(archive,out/'automake-source');source=out/'automake-source/automake-1.18.1'
    run('automake-configure',['/bin/sh','configure','--prefix='+str(out/'automake')],source,120);run('automake-build',['/usr/bin/make','-j','2'],source,180);run('automake-install',['/usr/bin/make','install'],source,120);env['PATH']=str(out/'automake/bin')+':'+env['PATH']
   for name in ['automake','aclocal']:
    tool=shutil.which(name,path=env['PATH']);assert tool
    tool_receipt[name]={'path':tool,'sha256':reference.sha(pathlib.Path(tool).resolve()),'version':run('tool-'+name,[tool,'--version'])}
   (out/'build-tools.json').write_text(json.dumps(tool_receipt,indent=2))
   env['ACLOCAL_PATH']='/usr/local/share/aclocal';prefix=out/'dependencies';prefix.mkdir();kegs=[]
   receipts=json.loads((reference_recipe/'bottle-receipt.json').read_text())
   for name,(version,library,linkname) in reference.DEPS.items():
    keg=reference.extract_bottle(helper,assets/(name+'.bottle.tar.gz'),prefix,name,version,receipts[name]);kegs.append(keg)
    target=keg/'lib'/library;target.unlink();shutil.copy2(native/'lib'/library,target);run('link-id-'+name,['/usr/bin/install_name_tool','-id',target,target]);run('link-sign-'+name,['/usr/bin/codesign','--force','--sign','-',target])
    alias=keg/'lib'/linkname
    if alias.is_symlink() or alias.exists():alias.unlink()
    alias.symlink_to(library);shutil.copy2(native/'licenses'/f'{library}.txt',keg/'COPYING')
    reference.rewrite_pkgconfig(keg)
   env['PKG_CONFIG_LIBDIR']=':'.join(str(keg/'lib/pkgconfig') for keg in kegs)
   archive=out/'upstream.tar';run('source-archive',['/usr/bin/git','-C',upstream,'archive','--format=tar','--output='+str(archive),pins['upstream']]);assert archive.stat().st_size<=32*1024**2
   helper.unpack_tar(archive,out/'source');source_dir=out/'source'
   run('autogen',['/bin/sh','autogen.sh'],source_dir,120);run('configure',['./configure','--enable-utf8proc','--disable-jemalloc'],source_dir,120);run('make',['/usr/bin/make','-j','2'],source_dir,600);source=source_dir/'tmux'
   (out/'source-proof.json').write_text(json.dumps({'commit':pins['upstream'],'archiveSha256':reference.sha(archive),'patches':[],'configure':['--enable-utf8proc','--disable-jemalloc']},indent=2))
  run('bundle',[node,HERE/'relocate-stock.mjs',source,out/'bundle',inputs/'recipe/mach-inputs.mjs',native,mode])
  assert run('stock-version',[out/'bundle/tmux','-V']).strip()=='tmux 3.7c';verify_input(inputs,manifest);ok=True
 finally:
  try:verify_input(inputs,manifest)
  except BaseException:ok=False;raise
  finally:
   try:run('processes-after',['/bin/ps','-axo','pid=,ppid=,stat=,lstart=,command='])
   except BaseException:ok=False;raise
   finally:(out/'status.json').write_text(json.dumps({'ok':ok,'mode':mode,'capabilityAdmissionPending':True,'performanceQualified':False,'native4998Rebuilt':False},indent=2))
if __name__=='__main__':main()
