// Draft, one explicitly approved private canonical case. No build is performed.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,unlinkSync,symlinkSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createScratchFleet} from '../../../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts';
import {startDaemon} from './daemon-traced.ts';
import {TmuxServerInteractionEventSchemaZ} from '@tmux-ide/contracts';
import {boundIssuerReference,reconcile} from './accounting.mjs';
import {seededIdle,retireStream,caseEnvironment,assertObservationMode} from './orchestration.mjs';
import {nativeStatusGuard,reconcileSetupCapture,boundedDaemonOutput,evidenceStatusBarrier} from './readiness.mjs';
import {linuxHost} from './linux-host.mjs';
import {tracePhase} from './trace-client.mjs';
import {verifyTrace} from './trace-verify.mjs';
import {captureDescendants} from './cleanup-witnesses.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const run=promisify(execFile), sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
assert.equal(process.argv[2],'--approved-case');
const spec=JSON.parse(readFileSync(process.argv[3],'utf8'));
assert(['disabled','enabled-no-reader','candidate32','reference'].includes(spec.mode));
assert(['cpu','idle'].includes(spec.lane));
const host=linuxHost(spec.host);await host.assertIdentity();
assert.equal(sha(spec.binary),spec.binarySha256);
assert.equal(sha(join(here,'../../../bin/cli.js')),spec.cliSha256);
const output=resolve(spec.output);mkdirSync(output,{mode:0o700});
mkdirSync(join(output,'bin'),{mode:0o700});symlinkSync(spec.binary,join(output,'bin/tmux'));
const cleanEnv=caseEnvironment(process.env,spec.mode,join(output,'bin')+':'+spec.systemPath);
for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,cleanEnv);
const app=join(output,'app.py');
writeFileSync(app,'import os,tty\ntty.setraw(0)\nn=0\nos.write(1,b"\\x1b[2J\\x1b[HCOUNT:0")\nwhile True:\n b=os.read(0,4096)\n assert all(c==120 for c in b)\n n+=len(b)\n os.write(1,("\\x1b[H\\x1b[2KCOUNT:"+str(n)).encode())\n',{mode:0o600});
const persist=(name,x)=>writeFileSync(join(output,name),JSON.stringify(x,null,2)+'\n',{mode:0o600});
let fleet,daemon,identity,witness,streamTask,streamError,status,epoch,appPid,appStart;
let traceSocket;let statusGuard;let setupIssuer;let journalCursor=0;const evidence=[],issuers=new Set(),cleanup=[],observed=new Set();const owned=new Map();let serverSample,appSample,daemonSample;
const abort=new AbortController();let cancelled=false,inCleanup=false;
process.on("SIGTERM",()=>{cancelled=true;abort.abort();});
let failure=null,result={mode:spec.mode,lane:spec.lane};
const command=async(args)=>{if(cancelled&&!inCleanup)throw Error('case cancelled');const r=await run(spec.binary,['-u','-S',fleet.socketPath,...args],{timeout:5000,maxBuffer:1048576});return r.stdout.trim();};
const retired=pid=>{const identity=owned.get(pid);assert(identity,'Missing process witness');return host.retired(pid,identity);};
const until=async(fn,ms=5000)=>{const end=Date.now()+ms;for(;;){if(cancelled&&!inCleanup)throw Error('case cancelled');if(await fn())return;if(Date.now()>=end)throw Error('bounded condition timed out');await sleep(5);}};
async function descendants(){
 const roots=[...(identity?[Number(identity[0])]:[]),...(daemon?[daemon.record.pid]:[])];
 const snap=await captureDescendants(roots,async(pid,remaining)=>{
  try{return (await run(spec.host.tools.pgrep.path,['-P',String(pid)],{timeout:Math.min(5000,remaining)})).stdout.trim().split(/\s+/).filter(Boolean).map(Number);}
  catch(e){if(e.code===1)return [];throw e;}
 });
 for(const pid of snap.pids){const sample=await host.observeOwnedProcess(pid,owned.get(pid));if(sample.status==='absent'||sample.status==='reused'){assert(owned.has(pid)||sample.status==='absent');continue;}assert.equal(sample.status,'present','Unreaped descendant');owned.set(pid,sample.startIdentity);observed.add(pid);}
 persist('witnesses.json',{pids:[...observed],identities:Object.fromEntries(owned),errors:snap.errors});
 assert.deepEqual(snap.errors,[],'descendant enumeration uncertain');return snap.pids;
}

async function stream(){
 const auth={Authorization:`Bearer ${daemon.record.authToken}`};
 const response=await fetch(daemon.baseUrl+'/api/v1/tmux-servers',{headers:auth,signal:AbortSignal.timeout(10000)});assert(response.ok);
 const servers=(await response.json()).servers;assert.equal(servers.length,1);const s=servers[0];assert.equal(s.state,'online');
 const r=await fetch(`${daemon.baseUrl}/api/v1/tmux-servers/${s.serverId}/${s.generation}/interaction-events?after=0`,{headers:auth,signal:abort.signal});assert(r.ok);
 const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';
 for(;;){const {done,value}=await reader.read();if(done)throw Error('owner stream ended');buffer+=decoder.decode(value,{stream:true});assert(buffer.length<=1048576);
  let index;while((index=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');if(!data)continue;
   const event=TmuxServerInteractionEventSchemaZ.parse(JSON.parse(data));
   if(event.type==='ready'||event.type==='status'){
    const next=event.observationStatus;
    if(spec.mode==='candidate32'){if(statusGuard)statusGuard.check(next);else if(next.method==='native-journal')statusGuard=nativeStatusGuard(next);}
    status=next;
   }
   if(event.type==='batch'){assert.equal(event.after,journalCursor);assert.equal(event.gap,null);journalCursor=event.cursor;for(const receipt of event.receipts)if(receipt.evidence)evidence.push(receipt.evidence);assert(evidence.length<=12000);}
  }
 }
}
async function pair(){
 const args=spec.mode==='reference'?[]:['tmux-ide-events','-i',';'];
 const text=await command([...args,'send-keys','-t',fleet.sessionNames[0],'-l','x',';','capture-pane','-p','-t',fleet.sessionNames[0]]);
 if(spec.mode!=='reference'){
  const first=text.indexOf('\n');assert(first>=0);const id=JSON.parse(text.slice(0,first));
  assert.equal(id.serverEpoch,epoch);assert.match(id.connectionId,/^[1-9][0-9]*$/);
  if(spec.mode==='candidate32')issuers.add(boundIssuerReference(status,epoch,id.connectionId));
 }
 const m=/COUNT:(\d+)/.exec(text);assert(m);return Number(m[1]);
}
try{
 fleet=await createScratchFleet({sessions:1,windowsPerSession:1,adoptSessions:false,slug:'whole-cpu',initialPaneCommand:{executable:spec.host.tools.python.path,args:[app]}});
 const st=lstatSync(fleet.socketPath);witness={dev:st.dev,ino:st.ino,uid:st.uid};identity=(await command(['display-message','-p','#{pid}\t#{start_time}'])).split('\t');assert.equal(identity.length,2);
 await until(async()=>/COUNT:0/.test(await command(['capture-pane','-p','-t',fleet.sessionNames[0]])));
 appPid=Number(await command(['display-message','-p','-t',fleet.sessionNames[0],'#{pane_pid}']));assert(Number.isSafeInteger(appPid)&&appPid>0);
 serverSample=await host.sampleOwnedProcess(Number(identity[0]));appSample=await host.sampleOwnedProcess(appPid);
 owned.set(serverSample.pid,serverSample.startIdentity);owned.set(appPid,appSample.startIdentity);
 appStart=await host.commandLine(appPid,appSample.startIdentity);assert(appStart.includes(app),'Unexpected fixture app process');
 persist('ownership.json',{appPid,appStart,root:fleet.root,socket:fleet.socketPath,identity,witness});
 if(spec.mode!=='reference'){const cap=JSON.parse(await command(['tmux-ide-events','-V']));epoch=cap.serverEpoch;assert.equal(cap.enabled,false);if(spec.mode==='enabled-no-reader')await command(['tmux-ide-events','-e']);}
 traceSocket=join(fleet.root,'trace.sock');
 const traceConfig=join(output,'trace-config.json');persist('trace-config.json',{ownerPid:process.pid,socket:traceSocket,log:join(output,'subprocess-trace.jsonl')});
 daemon=await startDaemon(fleet,{prebuiltCliSha256:spec.cliSha256,...(spec.lane==='idle'?{qualificationPreload:pathToFileURL(join(here,'trace-preload.mjs')).href+'?config='+encodeURIComponent(traceConfig)}:{})});
 daemonSample=await host.sampleOwnedProcess(daemon.record.pid);owned.set(daemon.record.pid,daemonSample.startIdentity);
 assert.equal(await host.parentPid(serverSample.pid,serverSample.startIdentity),1,'tmux server must be reparented to container init, outside fixture wait4');
 assert.equal(await host.parentPid(appSample.pid,appSample.startIdentity),serverSample.pid,'PTY app must remain child of orphan server');
 assert.equal(await host.parentPid(daemonSample.pid,daemonSample.startIdentity),process.pid,'canonical daemon must be fixture direct child');
 result.accountingOwnership={fixturePid:process.pid,daemonPid:daemonSample.pid,daemonParent:process.pid,serverParent:1,appParent:serverSample.pid,containerInit:true};
 persist('daemon-owned.json',{pid:daemon.record.pid,instanceId:daemon.record.instanceId});await descendants();
 streamTask=stream().catch(e=>{if(!abort.signal.aborted)streamError=e;});
 await until(()=>{if(streamError)throw streamError;return status&&status.method===(spec.mode==='candidate32'?'native-journal':'stock-hooks');},15000);
 if(spec.mode==='candidate32'){assert(statusGuard);statusGuard.check(status);result.bootstrapStatus=statusGuard.baseline;}
 const actualCapability=spec.mode==='reference'?null:JSON.parse(await command(['tmux-ide-events','-V']));
 assertObservationMode(spec.mode,actualCapability,status);
 if(actualCapability)assert.equal(actualCapability.serverEpoch,epoch,'Native server epoch changed during startup');
 // One capture-only setup connection in every mode, never a workload pair.
 const setupText=await command([...(spec.mode==='reference'?[]:['tmux-ide-events','-i',';']),'capture-pane','-p','-t',fleet.sessionNames[0]]);
 assert(/COUNT:0/.test(setupText));
 result.setup={command:'capture-pane',workloadPair:false,nativeEvidence:null};
 if(spec.mode==='candidate32'){
  const id=JSON.parse(setupText.slice(0,setupText.indexOf('\n')));assert.equal(id.serverEpoch,epoch);
  setupIssuer=boundIssuerReference(status,epoch,id.connectionId);
  await until(()=>{if(streamError)throw streamError;try{result.setup.nativeEvidence=reconcileSetupCapture(evidence,setupIssuer);return evidenceStatusBarrier(evidence,status,new Set([setupIssuer]));}catch{return false;}});
  assert(status.cursor,'Setup capture must advance native ingestion cursor');statusGuard.check(status);
  result.ingestionReadyStatus=structuredClone(status);
 }
 const idle=await seededIdle(spec,{pair,drain:()=>until(()=>{if(streamError)throw streamError;try{reconcile(evidence,issuers,1);return evidenceStatusBarrier(evidence,status,issuers);}catch{return false;}}),idleBegin:()=>tracePhase(traceSocket,'idle'),idleEnd:()=>tracePhase(traceSocket,'wake'),status:()=>status,snapshot:descendants,now:()=>performance.now(),sleep,check:()=>{if(cancelled)throw Error('case cancelled');if(streamError)throw streamError;}});
 if(idle)Object.assign(result,idle);
 const n=spec.lane==='cpu'?1500:1;
 const started=performance.now();let count=spec.lane==='idle'?1:0;
 for(let i=0;i<n;i++){if(streamError)throw streamError;const got=await pair();assert(got>=count&&got<=i+1+(spec.lane==='idle'?1:0));count=got;}
 // Capture-only final verification has a different connection; disclose as background.
 await until(async()=>Number(/COUNT:(\d+)/.exec(await command(['capture-pane','-p','-t',fleet.sessionNames[0]]))?.[1])===n+(spec.lane==='idle'?1:0));
 if(spec.mode==='candidate32')await until(()=>{if(streamError)throw streamError;try{result.counts=reconcile(evidence,issuers,n+(spec.lane==='idle'?1:0));return evidenceStatusBarrier(evidence,status,issuers);}catch{return false;}});
 result.elapsedSeconds=(performance.now()-started)/1000;result.reapedIdentities=[daemonSample.startIdentity];result.serverSample=await host.sampleOwnedProcess(serverSample.pid,serverSample.startIdentity);result.serverCpuSeconds=result.serverSample.cpuSeconds; // Fresh server cumulative CPU includes startup.
 assert.equal(await host.commandLine(appPid,appSample.startIdentity),appStart);
 assert.equal(await host.parentPid(serverSample.pid,serverSample.startIdentity),1);assert.equal(await host.parentPid(appSample.pid,appSample.startIdentity),serverSample.pid);
 result.orphanAppSample=await host.sampleOwnedProcess(appPid,appSample.startIdentity);result.orphanAppCpuSeconds=result.orphanAppSample.cpuSeconds; // PTY app is reaped by tmux, not fixture Node.
 if(spec.mode==='candidate32'){statusGuard.check(status);assert.equal(reconcileSetupCapture(evidence,setupIssuer),result.setup.nativeEvidence);}
 result.count=n+(spec.lane==='idle'?1:0);result.evidence=evidence;result.status=status;
 if(spec.lane==='idle')assert(result.elapsedSeconds<=0.1,'quiet wake exceeds100ms');
 await descendants();
}catch(e){failure=String(e.stack??e);}
finally{
 inCleanup=true;
 const retainLog=phase=>{try{persist(`daemon-${phase}.json`,boundedDaemonOutput(daemon));}catch(e){cleanup.push({error:`daemon log retention ${phase}: ${e}`});}};
 retainLog('before-stop');
 if(daemon&&spec.lane==='idle'){try{result.traceCleanupPhase=await tracePhase(traceSocket,'cleanup');}catch(e){cleanup.push({error:`trace cleanup phase: ${e}`});}}
 try{await descendants();}catch(e){cleanup.push({error:String(e)});}
 try{await retireStream(streamTask,abort);if(streamError)throw streamError;cleanup.push({streamRetired:true});}catch(e){cleanup.push({error:String(e)});}
 if(daemon){try{await host.sampleOwnedProcess(daemon.record.pid,daemonSample.startIdentity);await Promise.race([daemon.stop(),sleep(10000).then(()=>{throw Error('daemon stop timeout');})]);await until(()=>retired(daemon.record.pid));cleanup.push({daemonGone:true});}catch(e){cleanup.push({error:String(e)});}}
 retainLog('after-stop');
 if(spec.lane==='idle')try{result.trace=verifyTrace(readFileSync(join(output,'subprocess-trace.jsonl'),'utf8'),spec.binary);}catch(e){cleanup.push({error:`trace verification: ${e}`});}
 if(fleet){try{
  await host.sampleOwnedProcess(serverSample.pid,serverSample.startIdentity);
  assert.deepEqual((await command(['display-message','-p','#{pid}\t#{start_time}'])).split('\t'),identity);await command(['kill-server']);
  await until(async()=>{for(const pid of observed)if(!await retired(pid))return false;return true;});
  if(existsSync(fleet.socketPath)){const st=lstatSync(fleet.socketPath);assert(st.isSocket());assert.deepEqual({dev:st.dev,ino:st.ino,uid:st.uid},witness);unlinkSync(fleet.socketPath);}
  cleanup.push({ownedProcessesAbsent:true,socketAbsent:true});
  if(!cleanup.some(x=>x.error))await fleet.dispose();
 }catch(e){cleanup.push({error:String(e)});}}
 try{await host.assertIdentity();}catch(e){cleanup.push({error:`host identity changed: ${e}`});}
 const fixtureUsage=process.cpuUsage();
 result={...result,evidence,status,error:failure,cleanup,fixtureSelfCpuSeconds:(fixtureUsage.user+fixtureUsage.system)/1e6};persist('result.json',result);
 if(failure||cleanup.some(x=>x.error))process.exitCode=1;
}
