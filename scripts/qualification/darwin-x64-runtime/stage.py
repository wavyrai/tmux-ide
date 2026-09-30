"""Pure checked source transforms. Writes no product file and launches no process."""
import json,pathlib,re

def once(text,old,new):
 assert text.count(old)==1,('Expected exactly one source seam',old[:100],text.count(old))
 return text.replace(old,new)

def bind_daemon(text,paths):
 start=text.index('let bundleBuild: Promise<void> | null = null;')
 end=text.index('export async function startDaemon(',start)
 text=text[:start]+text[end:]
 text=once(text,'if (options.prebuiltCliSha256 === undefined) await ensureDaemonBundle();','if (options.prebuiltCliSha256 === undefined) throw new Error("Reviewed prebuilt CLI digest required; no build permitted");')
 rootline=next(line for line in text.splitlines() if line.startswith('export const repoRoot = '))
 text=once(text,rootline,'export const repoRoot = '+json.dumps(paths['source'])+';')
 for name in ['harness-process.ts','scratch-fleet.ts']:text=text.replace('from "./'+name+'"','from '+json.dumps(paths['source']+'/apps/desktop-renderer/e2e/fixtures/'+name))
 text=text.replace('join(repoRoot, "bin", "cli.js")',json.dumps(paths['cli']))
 text=text.replace('../../apps/desktop-renderer/e2e/fixtures/',paths['source']+'/apps/desktop-renderer/e2e/fixtures/')
 assert 'build-cli.mjs' not in text and 'ensureDaemonBundle' not in text
 return text

def bind_case(text,paths,idle=False):
 text=text.replace('../../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts',paths['source']+'/apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts')
 if not idle:text=once(text,"'../../apps/desktop-renderer/e2e/fixtures/daemon.ts'","'./daemon-prebuilt.ts'")
 text=once(text,"sha(join(here,'../../bin/cli.js'))","sha(spec.cli)")
 text="import {createOwnedProcessSampler} from './process-cpu.mjs';\nimport {fenceNativeTmuxCommand} from "+json.dumps(paths['source']+'/packages/daemon/src/lib/tmux-server-generation-runner.ts')+";\n"+text
 old="async function cpu(pid){const t=(await run('/bin/ps',['-o','time=','-p',String(pid)],{timeout:5000})).stdout.trim();const p=t.split(':').map(Number);assert(p.length===2&&p.every(Number.isFinite));return p[0]*60+p[1];}"
 new="""const ownedCpu=new Map();
const sampler=createOwnedProcessSampler({platform:'darwin',readSnapshot:async(pid)=>(await run('/bin/ps',['-p',String(pid),'-o','pid=','-o','lstart=','-o','state=','-o','time=','-o','command='],{timeout:5000,env:{...process.env,LC_ALL:'C',TZ:'UTC'}})).stdout});
async function rememberCpu(pid){const sample=await sampler.sampleOwnedProcess(Number(pid));ownedCpu.set(Number(pid),sample);return sample;}
async function cpu(pid){const prior=ownedCpu.get(Number(pid));assert(prior,'Missing initial owned CPU witness');const sample=await sampler.sampleOwnedProcess(Number(pid),prior.startIdentity);assert.equal(sample.command,prior.command,'Owned CPU command changed');persist('cpu-witness-'+pid+'.json',{before:prior,after:sample});return sample.cpuSeconds;}"""
 text=once(text,old,new)
 marker="persist('ownership.json',{appPid,appStart,root:fleet.root,socket:fleet.socketPath,identity,witness});"
 text=once(text,marker,marker+"\n await rememberCpu(identity[0]);await rememberCpu(appPid);")
 old="await command(['kill-server']);"
 new="""const live=lstatSync(fleet.socketPath);assert(live.isSocket());assert.deepEqual({dev:live.dev,ino:live.ino,uid:live.uid},witness);
  const fence=fenceNativeTmuxCommand(['-N','-u','kill-server'],{pid:identity[0],startTime:identity[1]});
  const retired=await run(spec.binary,['-S',fleet.socketPath,...fence.argv],{timeout:5000,maxBuffer:1048576});fence.verify(retired.stdout);"""
 text=once(text,old,new)
 if idle:
  text="import {finalCaptureDrained} from './final-capture-drain.mjs';\n"+text
  start=" await until(async()=>Number(/COUNT:(\\d+)/.exec(await command(['capture-pane','-p','-t',fleet.sessionNames[0]]))?.[1])===n+(spec.lane==='idle'?1:0));"
  replacement=""" let finalIssuer;
 await until(async()=>{
  const identified=spec.lane==='idle'&&spec.mode==='candidate32';
  const text=await command([...(identified?['tmux-ide-events','-i',';']:[]),'capture-pane','-p','-t',fleet.sessionNames[0]]);
  if(identified){const id=JSON.parse(text.slice(0,text.indexOf('\\n')));assert.equal(id.serverEpoch,epoch);finalIssuer=boundIssuerReference(status,epoch,id.connectionId);}
  return Number(/COUNT:(\\d+)/.exec(text)?.[1])===n+(spec.lane==='idle'?1:0);
 });"""
  text=once(text,start,replacement)
  old="result.counts=reconcile(evidence,issuers,n+(spec.lane==='idle'?1:0));return evidenceStatusBarrier(evidence,status,issuers);"
  text=once(text,old,old[:-1]+"&&(spec.lane!=='idle'||finalCaptureDrained(evidence,status,{setupIssuer,pairIssuers:issuers,finalIssuer}));")
 return text

def bind_component(text,paths):
 # Literal path substitutions only; no measurement body or gate rewrite.
 text=text.replace('/Users/thijs/Developer/tmux-ide/.tasks/current-native-components-657e0c97b9ee4def9db18f0c43181cbc/source',paths['source'])
 text=text.replace('/private/tmp/tmux-ide-native-arm-888c15d4/.tasks/qualification/bundle/tmux',paths['native'])
 text=text.replace('/opt/homebrew/Cellar/node/26.8.2/bin/node',paths['node'])
 text=text.replace('../../../scripts/',paths['source']+'/scripts/').replace('../../../packages/',paths['source']+'/packages/')
 assert '/opt/homebrew' not in text and 'tmux-ide-native-arm' not in text
 return text

def stage_sources(binding,output,base=None):
 import hashlib,shutil,difflib
 base=pathlib.Path(base or __file__).resolve().parent;output=pathlib.Path(output)
 assert binding['executionAuthorized'] is False and binding['runtimePatch'] is None
 assert not output.exists(),'Fresh overlay required'
 sources=json.loads((base/'upstream.json').read_text())
 for name,row in sources.items():assert hashlib.sha256((base/name).read_bytes()).hexdigest()==row['sha256'],name
 paths=binding['paths'];output.mkdir(mode=0o700);diff=[];files={}
 (output/'package.json').write_text('{"type":"module"}\n')
 (output/'node_modules').symlink_to(pathlib.Path(paths['source'])/'node_modules',target_is_directory=True)
 for lane in ['cpu','idle','parser','metadata','tail']:
  dest=output/lane;dest.mkdir()
  for p in sorted((base/'upstream'/lane).iterdir()):
   original=p.read_text();text=original
   if p.name=='case.mjs':text=bind_case(text,paths,lane=='idle')
   elif p.name in ['daemon-prebuilt.ts','daemon-traced.ts']:text=bind_daemon(text,paths)
   elif lane in ['parser','metadata','tail']:text=bind_component(text,paths)
   (dest/p.name).write_text(text)
   diff.extend(difflib.unified_diff(original.splitlines(True),text.splitlines(True),fromfile='original/'+lane+'/'+p.name,tofile='bound/'+lane+'/'+p.name))
  if lane in ['cpu','idle']:
   shutil.copyfile(base/'upstream/process-cpu.mjs',dest/'process-cpu.mjs')
   if lane=='idle':shutil.copyfile(base/'upstream/final-capture-drain.mjs',dest/'final-capture-drain.mjs')
 for p in sorted(output.rglob('*')):
  if p.is_file() and not p.is_symlink():files[str(p.relative_to(output))]=hashlib.sha256(p.read_bytes()).hexdigest()
 (output/'binding.diff').write_text(''.join(diff))
 (output/'staging.json').write_text(json.dumps({'executionAuthorized':False,'paths':paths,'files':files,'missingAdmission':['freshHost','fullFreeze','laneAuthorization'],'runtimePatch':None},indent=2)+'\n')
 return files
