import { AuthoredNativeReceiptEnricher } from '/work/source/packages/daemon/src/lib/authored-native-receipt-staging.ts';
import { NativeTmuxInteractionObserver } from '/work/source/packages/daemon/src/lib/native-tmux-interaction-observer.ts';
import { OwnerInteractionObservation } from '/work/source/packages/daemon/src/lib/owner-interaction-observation.ts';
import { InteractionReceiptJournal } from '/work/source/packages/daemon/src/lib/interaction-receipt-journal.ts';
import { InteractionObservationStatusStore } from '/work/source/packages/daemon/src/lib/interaction-observation-status.ts';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [binary,socket,pid,startTime,windowRaw='0',telemetry='none',readyPath]=process.argv.slice(2);
const observationBatchMs=Number(windowRaw) as 0|16|32; if(![0,16,32].includes(observationBatchMs))throw Error('Invalid experimental window');
const id='11111111-1111-4111-8111-111111111111';
const scope={serverId:"tmux-server.11111111111111111111111111111111",generation:id};
const journal=new InteractionReceiptJournal();
const status=new InteractionObservationStatusStore(id,scope);
const stats={records:0,batches:0,gaps:0,kinds:{} as Record<string,number>,last:'0',states:[] as string[],published:0,effects:{} as Record<string,number>};
const enricher=new AuthoredNativeReceiptEnricher({journal,publishRaw:(evidence)=>journal.appendEvidence(evidence),noteGap:()=>observer.noteOwnedOperationUncertainty(),onFailure:()=>observer.failOwnedOperationObservation()});
const observer=new OwnerInteractionObservation({environmentId:id,serverScope:scope,tmuxAuthority:{executablePath:binary!,socketSelector:{kind:'path',path:socket!}},nativeServerIdentity:{pid:pid!,startTime:startTime!},enabled:true,status,publishOwnedEvidence:(decision)=>enricher.consume(decision),publishEvidence(evidence){journal.appendEvidence(evidence);stats.published++;stats.effects[evidence.effect.kind]=(stats.effects[evidence.effect.kind]??0)+1;},readerFactory(options){return new NativeTmuxInteractionObserver({...options,timing:{...options.timing,observationBatchMs},onEvent(e){options.onEvent(e);if(e.type==='batch'){stats.batches++;if(telemetry==='latency')console.log(JSON.stringify({backlog:e.batch.next!==e.batch.newest,batchSize:e.batch.records.length,latency:e.batch.records.map(r=>({kind:r.kind,us:r.monotonicUs}))}));for(const r of e.batch.records){stats.records++;stats.kinds[r.kind]=(stats.kinds[r.kind]??0)+1;stats.last=r.sequence;}}else if(e.type==='gap')stats.gaps++;else if(e.type==='state')stats.states.push(e.status);}});}});
await observer.start();
if(observer.selection!=='native')throw new Error('Native owner not selected');
const ready={ready:true,pid:process.pid,cpu:process.cpuUsage()};console.log(JSON.stringify(ready));if(readyPath)writeFileSync(readyPath,JSON.stringify(ready));
let closing=false;
async function stop(){if(closing)return;closing=true;
if(telemetry==='echo'){
 const native=JSON.parse(execFileSync(binary!,['-S',socket!,'tmux-ide-events','-V'],{encoding:'utf8'}));
 // Native capability has no newest cursor; a read-only bounded read reports it.
 const tail=JSON.parse(execFileSync(binary!,['-S',socket!,'tmux-ide-events','-r','-E',native.journalEpoch,'-a',stats.last,'-n','64'],{encoding:'utf8'}));
 const deadline=Date.now()+2000;
 while(BigInt(stats.last)<BigInt(tail.newest)){if(Date.now()>deadline)throw Error('Echo observation tail not drained');await new Promise(r=>setTimeout(r,5));}
}
enricher.dispose();await observer.dispose();const snapshot=status.getSnapshot();const retained=journal.read(0);
if(stats.published!==(stats.effects['input-enqueued']??0)+(stats.effects['snapshot-produced']??0))throw Error('Unprojected effects');
if((stats.effects['input-enqueued']??0)!==(stats.kinds['5']??0)||(stats.effects['snapshot-produced']??0)!==(stats.kinds['6']??0))throw Error('Effect count mismatch');
if(snapshot.method!=='native-journal'||(stats.last!=='0'&&snapshot.cursor?.sequence!==stats.last))throw Error('Owner status mismatch');
journal.dispose();status.dispose();const result={...stats,enricherPending:enricher.pendingCount,retained:retained.receipts.length,journalCursor:retained.cursor,cpu:process.cpuUsage()};
console.log(JSON.stringify(result));if(readyPath)writeFileSync(readyPath+'.result.json',JSON.stringify(result));process.exit(0);}
if(telemetry==='echo'){process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());}
else for await(const line of createInterface({input:process.stdin})){if(line==='stop')await stop();else console.log(JSON.stringify(telemetry==='lifecycle'?{...stats,memory:process.memoryUsage(),cpu:process.cpuUsage(),retained:journal.read(0).receipts.length,enricherPending:enricher.pendingCount,status:status.getSnapshot(),spawnAttempts:(globalThis as Record<symbol,unknown>)[Symbol.for("tmux-ide.lifecycle-spawns")]}:stats));}
