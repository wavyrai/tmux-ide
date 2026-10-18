import pathlib,subprocess,json
root=pathlib.Path.cwd(); out=root/'.tasks/native-reliability-mission/nr01-heap-diagnostic'; src=root/'.tasks/native-reliability-mission/nr01-current-payload'
name='tmux-ide-nr01-heap-99e4759d'
def run(args): return subprocess.check_output(args,text=True).strip()
probe="const fs=require('node:fs');fs.appendFileSync('/tmp/node-heaps.jsonl',JSON.stringify({pid:process.pid,entry:process.argv[1],heapLimit:require('node:v8').getHeapStatistics().heap_size_limit})+'\\n');"
(out/'probe.cjs').write_text(probe)
p= (root/'scripts/lib/product-fixtures/daemon.ts').read_text()
assert p.count('delete environment.NODE_OPTIONS;')==1
p=p.replace('delete environment.NODE_OPTIONS;', 'environment.NODE_OPTIONS = "--max-old-space-size=128 --require=/tmp/probe.cjs";')
(out/'daemon.ts').write_text(p)
command='tar -xf /tmp/source-overlay.tar -C /work && cp /tmp/daemon.ts /work/scripts/lib/product-fixtures/daemon.ts && env -u TMUX_IDE_RUNTIME_MODE NODE_OPTIONS="--max-old-space-size=128 --require=/tmp/probe.cjs" TMUX_GPUI_TEST_CLI=/work/.tasks/current-cli.mjs TMUX_GPUI_TEST_BUNDLE=/work/.tasks/current-bridge timeout --signal=TERM --kill-after=10s 90s node --import tsx apps/tmux-gpui/bridge/browser-smoke.mjs; result=$?; cat /sys/fs/cgroup/memory.events; cat /tmp/node-heaps.jsonl; exit "$result"'
args=['docker','create','--name',name,'--network','none','--cpus=2','--memory=768m','--pids-limit=256','sha256:051c5eff12767eb13f4288d36112233b099e2925739b6612591a50e6af630653','sh','-c',command]
cid=run(args); receipt={'container':cid,'command':args,'classification':'separate constrained-heap diagnostic, not default qualification'}
(out/'receipt.json').write_text(json.dumps(receipt,indent=2))
for a,b in [(src/'source-overlay.tar','/tmp/source-overlay.tar'),(src/'cli.mjs','/work/.tasks/current-cli.mjs'),(src/'bridge','/work/.tasks/current-bridge'),(out/'probe.cjs','/tmp/probe.cjs'),(out/'daemon.ts','/tmp/daemon.ts')]: run(['docker','cp',str(a),cid+':'+b])
with (out/'runtime.log').open('w') as f: result=subprocess.run(['docker','start','-a',cid],stdout=f,stderr=subprocess.STDOUT)
receipt['exitCode']=result.returncode;receipt['inspect']=json.loads(run(['docker','inspect',cid]))[0]
(out/'receipt.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps({'exitCode':result.returncode,'state':receipt['inspect']['State']}))
if not receipt['inspect']['State']['Running']: run(['docker','rm',cid])
