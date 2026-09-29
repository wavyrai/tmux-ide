"""Closed one-shot Intel reference input intake/build/package; no Homebrew or campaign."""
import sys
sys.dont_write_bytecode=True
import argparse,json,pathlib,os,platform,importlib.util,urllib.request,urllib.parse,time,hashlib,shutil
from intake import intake
from admission import unpack,verify_input,sha
from bounded import run_bounded
from payload import package_payload
HERE=pathlib.Path(__file__).resolve().parent;RECIPE=HERE.parent

def download(request,path,expected,cap):
 start=time.monotonic();total=0
 with urllib.request.urlopen(request,timeout=30) as src,path.open('xb') as dst:
  while True:
   assert time.monotonic()-start<180,'Download deadline'
   data=src.read(1024*1024)
   if not data:break
   total+=len(data);assert total<=cap,'Download cap';dst.write(data)
 assert sha(path)==expected,'Download hash'
 return {'file':path.name,'bytes':total,'sha256':expected}

def main():
 p=argparse.ArgumentParser()
 for name in ['metadata','archive','output']:p.add_argument('--'+name,required=True)
 a=p.parse_args();out=pathlib.Path(a.output).resolve();assert platform.system()=='Darwin' and platform.machine()=='x86_64'
 pins=json.loads((HERE/'pins.json').read_text());assert pins['executionAuthorized'] is True,'Reference build not authorized'
 for relative,digest in pins['recipeHashes'].items():assert sha(RECIPE/relative)==digest,'Recipe hash mismatch'
 assert not out.exists();out.mkdir(mode=0o700);os.umask(0o077)
 for name in ['home','logs','assets']:(out/name).mkdir()
 env={'HOME':str(out/'home'),'PATH':'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'C','TZ':'UTC','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'}
 stages=[];success=False;manifest=None;inputs=out/'inputs'
 def run(name,args,timeout=60):
  with (out/'logs'/f'{name}.log').open('xb') as log:r=run_bounded([str(x) for x in args],env=env,timeout=timeout,limit=8*1024**2,output=log)
  stages.append({'stage':name,'code':r.returncode,'truncated':r.truncated});(out/'stages.json').write_text(json.dumps(stages,indent=2))
  assert r.returncode==0 and not r.truncated
  return (out/'logs'/f'{name}.log').read_text()
 try:
  intake(pathlib.Path(a.metadata),pathlib.Path(a.archive),out/'intake',pins)
  receipt=json.loads((out/'intake/payload-manifest.json').read_text());manifest=receipt['members']
  unpack(out/'intake/inputs.tar.gz',inputs,manifest);verify_input(inputs,manifest)
  downloads=[]
  for name,bottle in json.loads((RECIPE/'bottle-receipt.json').read_text()).items():
   assert name in ('utf8proc','libevent','ncurses')
   url='https://ghcr.io/token?'+urllib.parse.urlencode({'service':'ghcr.io','scope':f'repository:homebrew/core/{name}:pull'})
   with urllib.request.urlopen(url,timeout=30) as response:
    token=json.loads(response.read(65537));assert isinstance(token['token'],str) and len(token['token'])<65536
   expected='https://ghcr.io/v2/homebrew/core/'+name+'/blobs/sha256:'+bottle['sha256'];assert bottle['url']==expected
   request=urllib.request.Request(expected,headers={'Authorization':'Bearer '+token['token']})
   downloads.append(download(request,out/'assets'/(name+'.bottle.tar.gz'),bottle['sha256'],32*1024**2))
  downloads.append(download('https://ftp.gnu.org/gnu/automake/automake-1.18.1.tar.xz',out/'assets/automake-1.18.1.tar.xz','168aa363278351b89af56684448f525a5bce5079d0b6842bd910fdd3f1646887',8*1024**2))
  (out/'downloads.json').write_text(json.dumps(downloads,indent=2))
  upstream=out/'tmux-source';run('git-init',['/usr/bin/git','init',upstream]);run('git-origin',['/usr/bin/git','-C',upstream,'remote','add','origin','https://github.com/tmux/tmux.git'])
  run('git-fetch',['/usr/bin/git','-C',upstream,'fetch','--depth=1','origin',pins['upstream']],120)
  run('git-checkout',['/usr/bin/git','-C',upstream,'checkout','--detach',pins['upstream']])
  assert run('git-head',['/usr/bin/git','-C',upstream,'rev-parse','HEAD']).strip()==pins['upstream']
  sys.path.insert(0,str(RECIPE));spec=importlib.util.spec_from_file_location('reference_build',RECIPE/'build-reference.py');build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
  sys.argv=['build-reference.py','--inputs',str(inputs),'--payload-manifest',str(out/'intake/payload-manifest.json'),'--upstream',str(upstream),'--output',str(out/'reference'),'--assets',str(out/'assets')]
  build.main()
  verify_input(inputs,manifest)
  result=package_payload(out,['reference/bundle','reference/mach-closure.json','reference/build-tools.json','reference/status.json','reference/stages.json','downloads.json'],out/'matched-reference.tar',out/'roundtrip')
  result['sha256']=sha(out/'matched-reference.tar');(out/'payload.json').write_text(json.dumps(result,indent=2));success=True
 finally:
  try:
   if manifest is not None and inputs.exists():verify_input(inputs,manifest)
  except BaseException:
   success=False;raise
  finally:
   try:run('processes-after',['/bin/ps','-axo','pid=,ppid=,stat=,lstart=,command='])
   except BaseException:
    success=False;raise
   finally:(out/'status.json').write_text(json.dumps({'ok':success,'performanceQualified':False,'instrumentedNativeRebuilt':False,'scope':'reference-build-only'},indent=2))
if __name__=='__main__':main()
