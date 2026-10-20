import pathlib,subprocess,json,hashlib,uuid,time
root=pathlib.Path.cwd();src=root/'.tasks/native-reliability-mission/nr01-current-idle-requalification';out=src
bridge=root/'.tasks/native-reliability-mission/current-native-09e7bd45-final/Tmux IDE CI.app/Contents/Resources/bridge'
name='tmux-ide-nr01-idle-'+uuid.uuid4().hex[:12]
image='sha256:051c5eff12767eb13f4288d36112233b099e2925739b6612591a50e6af630653'
def run(args,timeout=30):return subprocess.check_output(args,text=True,timeout=timeout).strip()
def hashes():return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [src/'source-overlay.tar',src/'source.json',*sorted(bridge.glob('*')),root/'bin/cli.js'] if p.is_file()}
before=hashes()
assert before[str((bridge/'browser.bundle.mjs').relative_to(root))]=='cad69a1026c6263c1561cb977dac2600359d7bf0db9ca58423cf993c3c05e7d8'
assert before[str((bridge/'live.bundle.mjs').relative_to(root))]=='a1282eeb5f0a374bc5b8b87a03f6e5637e01d97f358c301ea6cfe268864e22b0'
active=run(['docker','ps','--format','{{.ID}} {{.Names}}']);assert not active,'Other active containers; stop without mutation'
metrics="const f=require('fs');const r=p=>{try{return f.readFileSync(p,'utf8').trim()}catch{return null}};f.writeFileSync(process.argv[1],JSON.stringify({events:r('/sys/fs/cgroup/memory.events'),current:r('/sys/fs/cgroup/memory.current'),peak:r('/sys/fs/cgroup/memory.peak'),max:r('/sys/fs/cgroup/memory.max'),meminfo:r('/proc/meminfo'),nodeOptions:process.env.NODE_OPTIONS??null}));"
import shlex
measure=lambda dest:'env -u NODE_OPTIONS node -e '+shlex.quote(metrics)+' '+dest
command=measure('/tmp/memory-before.json')+' && tar -xf /tmp/source-overlay.tar -C /work && env -u NODE_OPTIONS timeout --signal=TERM --kill-after=10s 60s node scripts/build-cli.mjs --outfile /work/.tasks/current-cli.mjs --metafile /tmp/cli-metafile.json && sha256sum /work/.tasks/current-cli.mjs && env -u NODE_OPTIONS node /work/.tasks/current-cli.mjs --version && node --version && tmux -V && uname -m && env -u NODE_OPTIONS -u TMUX_IDE_RUNTIME_MODE TMUX_GPUI_TEST_CLI=/work/.tasks/current-cli.mjs TMUX_GPUI_TEST_BUNDLE=/work/.tasks/current-bridge timeout --signal=TERM --kill-after=10s 90s node --import tsx apps/tmux-gpui/bridge/browser-smoke.mjs; result=$?; '+measure('/tmp/memory-after.json')+'; exit "$result"'
args=['docker','create','--name',name,'--network','none','--cpus=2','--memory=768m','--pids-limit=256',image,'sh','-c',command]
receipt={'scope':'current tracked overlay and current packaged09bridge; supported currentCLI built only in isolatedcontainer; defaultNode options','command':args,'hashesBefore':before,'containersBefore':active,'dockerMemTotalBefore':int(run(['docker','info','--format','{{.MemTotal}}'])),'cleanup':False}
cid=None
try:
 cid=run(args);receipt['container']=cid
 for a,b in [(src/'source-overlay.tar','/tmp/source-overlay.tar'),(bridge,'/work/.tasks/current-bridge')]:run(['docker','cp',str(a),cid+':'+b])
 with (out/'runtime.log').open('x') as log:
  child=subprocess.Popen(['docker','start','-a',cid],stdout=log,stderr=subprocess.STDOUT)
  time.sleep(1);receipt['containersDuring']=run(['docker','ps','--format','{{.ID}} {{.Names}}'])
  try:receipt['exitCode']=child.wait(timeout=180)
  except subprocess.TimeoutExpired:
   receipt['outerTimeout']=True;run(['docker','stop','--time','5',cid]);receipt['exitCode']=child.wait(timeout=15)
finally:
 if cid:
  receipt['inspect']=json.loads(run(['docker','inspect',cid]))[0]
  for label in ['before','after']:
   try:
    run(['docker','cp',cid+':/tmp/memory-'+label+'.json',str(out/('memory-'+label+'.json'))]);receipt['memory'+label.title()]=json.loads((out/('memory-'+label+'.json')).read_text())
   except (subprocess.SubprocessError,FileNotFoundError,json.JSONDecodeError):receipt['memory'+label.title()]=None
  try:run(['docker','cp',cid+':/tmp/cli-metafile.json',str(out/'cli-metafile.json')])
  except subprocess.SubprocessError:receipt['metafileMissing']=True
  try:
   run(['docker','cp',cid+':/work/.tasks/current-cli.mjs',str(out/'cli.mjs')]);receipt['currentCliSha256']=hashlib.sha256((out/'cli.mjs').read_bytes()).hexdigest();receipt['matchesPriorCli']=receipt['currentCliSha256']=='d4252e328292012da246bc086833c3720b0e55365e50e5da86826a4f2c31b1f5'
  except subprocess.SubprocessError:receipt['cliMissing']=True
  if receipt['inspect']['State']['Running']:run(['docker','stop','--time','5',cid]);receipt['forcedStop']=True
  run(['docker','rm',cid]);receipt['cleanup']=cid not in run(['docker','ps','-aq','--no-trunc']).splitlines()
 receipt['hashesAfter']=hashes();receipt['hashesUnchanged']=receipt['hashesAfter']==before
 receipt['containersAfter']=run(['docker','ps','--format','{{.ID}} {{.Names}}']);receipt['dockerMemTotalAfter']=int(run(['docker','info','--format','{{.MemTotal}}']))
 receipt['passed']=receipt.get('exitCode')==0 and receipt['cleanup'] and receipt['hashesUnchanged'] and not receipt.get('outerTimeout') and not receipt.get('inspect',{}).get('State',{}).get('OOMKilled',True)
 with (out/'receipt.json').open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
 print(json.dumps({'passed':receipt['passed'],'cleanup':receipt['cleanup'],'exitCode':receipt.get('exitCode')}))
raise SystemExit(0 if receipt['passed'] else 1)
