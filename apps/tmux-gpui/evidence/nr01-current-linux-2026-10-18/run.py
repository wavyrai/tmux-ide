import subprocess,json,pathlib,hashlib,time
root=pathlib.Path.cwd(); out=root/'.tasks/native-reliability-mission/nr01-current-linux'; name='tmux-ide-nr01-current-20261018'
bridge=pathlib.Path('/Volumes/Samsung_T5/Developer/tmux-ide/.tasks/nr-current-native-20261018/Tmux IDE Reliability QA.app/Contents/Resources/bridge')
image='sha256:051c5eff12767eb13f4288d36112233b099e2925739b6612591a50e6af630653'
def run(args,check=True):
 p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 if check and p.returncode: raise RuntimeError(str(args)+': '+p.stdout)
 return p

def hashes(): return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in bridge.iterdir() if p.is_file()}
r={'image':image,'bridgeBefore':hashes(),'cliSource':'4c45fa9f04b92a82b716e2b7f658038098e82d38','cliKind':'cached Linux source-bundled CLI, not npm installed or latest daemon','head':run(['git','rev-parse','HEAD']).stdout.strip()}
command="sha256sum /work/.tasks/private-cli.mjs; node /work/.tasks/private-cli.mjs --version; node --version; tmux -V; uname -m; grep -n attemptCharged /work/packages/daemon/src/terminal/mirror/session-channel.ts; env -u TMUX_IDE_RUNTIME_MODE TMUX_GPUI_TEST_CLI=/work/.tasks/private-cli.mjs TMUX_GPUI_TEST_BUNDLE=/work/.tasks/current-bridge timeout --signal=TERM --kill-after=10s 90s node --import tsx apps/tmux-gpui/bridge/browser-smoke.mjs; result=$?; cat /sys/fs/cgroup/memory.events; exit \"$result\""
args=['docker','create','--name',name,'--network','none','--cpus=2','--memory=768m','--pids-limit=256',image,'sh','-c',command]; r['createCommand']=args
created=False
try:
 run(args);created=True
 run(['docker','cp',str(bridge),name+':/work/.tasks/current-bridge'])
 for rel in ['apps/tmux-gpui/bridge/browser-smoke.mjs','scripts/lib/product-fixtures/daemon.ts']:
  run(['docker','cp',str(root/rel),name+':/work/'+rel])
  r.setdefault('currentHarnessHashes',{})[rel]=hashlib.sha256((root/rel).read_bytes()).hexdigest()
 p=run(['docker','start','-a',name],False);r['exitCode']=p.returncode;(out/'runtime.log').write_text(p.stdout)
 r['inspect']=json.loads(run(['docker','inspect',name]).stdout)[0]
except Exception as e:r['error']=str(e)
finally:
 if created:
  p=run(['docker','rm','-f',name],False);r['removed']=p.returncode==0
 r['bridgeAfter']=hashes();r['bridgeStable']=r['bridgeBefore']==r['bridgeAfter'];(out/'receipt.json').write_text(json.dumps(r,indent=2)+'\n')
 print(json.dumps({k:v for k,v in r.items() if k in ['exitCode','error','removed','bridgeStable']}))
