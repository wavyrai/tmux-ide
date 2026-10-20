import pathlib,subprocess,json,hashlib,uuid,time
root=pathlib.Path.cwd();src=root/'.tasks/native-reliability-mission/nr01-current-payload';out=root/'.tasks/native-reliability-mission/nr01-default-idle-requalification'
name='tmux-ide-nr01-idle-'+uuid.uuid4().hex[:12]
image='sha256:051c5eff12767eb13f4288d36112233b099e2925739b6612591a50e6af630653'
def run(args,timeout=30):return subprocess.check_output(args,text=True,timeout=timeout).strip()
def hashes():return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [src/'source-overlay.tar',src/'cli.mjs',*sorted((src/'bridge').glob('*')),root/'bin/cli.js'] if p.is_file()}
before=hashes();original=json.loads((src/'receipt.json').read_text());assert before[str((src/'cli.mjs').relative_to(root))]==original['cliSha256']
for f,details in original['bridgeManifest']['files'].items():assert before[str((src/'bridge'/f).relative_to(root))]==details['sha256']
active=run(['docker','ps','--format','{{.ID}} {{.Names}}']);assert not active,'Other active containers; stop without mutation'
metrics="const f=require('fs');const r=p=>{try{return f.readFileSync(p,'utf8').trim()}catch{return null}};f.writeFileSync(process.argv[1],JSON.stringify({events:r('/sys/fs/cgroup/memory.events'),current:r('/sys/fs/cgroup/memory.current'),peak:r('/sys/fs/cgroup/memory.peak'),max:r('/sys/fs/cgroup/memory.max'),meminfo:r('/proc/meminfo'),nodeOptions:process.env.NODE_OPTIONS??null}));"
import shlex
measure=lambda dest:'env -u NODE_OPTIONS node -e '+shlex.quote(metrics)+' '+dest
command=measure('/tmp/memory-before.json')+' && tar -xf /tmp/source-overlay.tar -C /work && sha256sum /work/.tasks/current-cli.mjs && env -u NODE_OPTIONS node /work/.tasks/current-cli.mjs --version && node --version && tmux -V && uname -m && env -u NODE_OPTIONS -u TMUX_IDE_RUNTIME_MODE TMUX_GPUI_TEST_CLI=/work/.tasks/current-cli.mjs TMUX_GPUI_TEST_BUNDLE=/work/.tasks/current-bridge timeout --signal=TERM --kill-after=10s 90s node --import tsx apps/tmux-gpui/bridge/browser-smoke.mjs; result=$?; '+measure('/tmp/memory-after.json')+'; exit "$result"'
args=['docker','create','--name',name,'--network','none','--cpus=2','--memory=768m','--pids-limit=256',image,'sh','-c',command]
receipt={'scope':'exact frozen873ef58e default payload rerun after user stopped other containers; not current-source qualification','command':args,'hashesBefore':before,'containersBefore':active,'dockerMemTotalBefore':int(run(['docker','info','--format','{{.MemTotal}}'])),'cleanup':False}
cid=None
try:
 cid=run(args);receipt['container']=cid
 for a,b in [(src/'source-overlay.tar','/tmp/source-overlay.tar'),(src/'cli.mjs','/work/.tasks/current-cli.mjs'),(src/'bridge','/work/.tasks/current-bridge')]:run(['docker','cp',str(a),cid+':'+b])
 with (out/'runtime.log').open('x') as log:
  child=subprocess.Popen(['docker','start','-a',cid],stdout=log,stderr=subprocess.STDOUT)
  time.sleep(1);receipt['containersDuring']=run(['docker','ps','--format','{{.ID}} {{.Names}}'])
  try:receipt['exitCode']=child.wait(timeout=115)
  except subprocess.TimeoutExpired:
   receipt['outerTimeout']=True;run(['docker','stop','--time','5',cid]);receipt['exitCode']=child.wait(timeout=15)
finally:
 if cid:
  receipt['inspect']=json.loads(run(['docker','inspect',cid]))[0]
  for label in ['before','after']:
   try:
    run(['docker','cp',cid+':/tmp/memory-'+label+'.json',str(out/('memory-'+label+'.json'))]);receipt['memory'+label.title()]=json.loads((out/('memory-'+label+'.json')).read_text())
   except (subprocess.SubprocessError,FileNotFoundError,json.JSONDecodeError):receipt['memory'+label.title()]=None
  if receipt['inspect']['State']['Running']:run(['docker','stop','--time','5',cid]);receipt['forcedStop']=True
  run(['docker','rm',cid]);receipt['cleanup']=cid not in run(['docker','ps','-aq','--no-trunc']).splitlines()
 receipt['hashesAfter']=hashes();receipt['hashesUnchanged']=receipt['hashesAfter']==before
 receipt['containersAfter']=run(['docker','ps','--format','{{.ID}} {{.Names}}']);receipt['dockerMemTotalAfter']=int(run(['docker','info','--format','{{.MemTotal}}']))
 receipt['passed']=receipt.get('exitCode')==0 and receipt['cleanup'] and receipt['hashesUnchanged'] and not receipt.get('outerTimeout') and not receipt.get('inspect',{}).get('State',{}).get('OOMKilled',True)
 with (out/'receipt.json').open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
 print(json.dumps({'passed':receipt['passed'],'cleanup':receipt['cleanup'],'exitCode':receipt.get('exitCode')}))
raise SystemExit(0 if receipt['passed'] else 1)
