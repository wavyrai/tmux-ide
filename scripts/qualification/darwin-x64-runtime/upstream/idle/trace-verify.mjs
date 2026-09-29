import assert from 'node:assert/strict';
export function verifyTrace(text,expectedBinary){
 assert(Buffer.byteLength(text)<=1048576);assert(text.endsWith('\n'));
 const rows=text.trim().split('\n').map(x=>JSON.parse(x));assert(rows.length<=10000);
 rows.forEach((r,i)=>{assert.equal(r.seq,i+1);assert.match(r.atNs,/^[0-9]+$/);if(i)assert(BigInt(r.atNs)>=BigInt(rows[i-1].atNs));});
 const phases=rows.filter(r=>r.type==='phase');assert.deepEqual(phases.map(r=>r.phase),['idle','wake','cleanup']);
 assert.equal(rows[0].type,'trace-ready');assert.equal(rows.filter(r=>r.type==='trace-ready').length,1);
 assert(BigInt(phases[1].atNs)-BigInt(phases[0].atNs)>=125000000000n,'Trace idle phase shorter than125s');
 const terminal=rows.filter(r=>r.type==='process-exit');assert.equal(terminal.length,1,'Expected unique terminal trace');
 assert.equal(rows.at(-1),terminal[0],'Terminal trace must be last');assert.equal(terminal[0].code,0,'Daemon exited unsuccessfully');
 const idle=rows.filter(r=>r.phase==='idle');
 // Any shell during idle prevents a complete native-producer classification.
 assert(!idle.some(r=>r.type==='attempt'&&r.shell),'Unclassified shell invocation during idle');
 assert(expectedBinary,'Exact native binary required');
 const nativeCalls=rows.filter(r=>r.type==='attempt'&&(r.argv.some(arg=>arg.includes('tmux-ide-events'))||r.executable.includes('tmux-ide-events')));
 for(const call of nativeCalls){assert.equal(call.shell,false,'Uncovered shell event invocation');assert.equal(call.executableResolved,expectedBinary,'Unresolved or mismatched native event executable');assert.notEqual(call.phase,'idle','Recurring native event invocation during idle');}
 const producers=nativeCalls.filter(r=>r.argv.includes('tmux-ide-events')&&r.argv.includes('-P'));
 assert.equal(producers.length,1,'Expected one persistent producer connection');
 assert.equal(producers[0].phase,'startup');
 if(expectedBinary)assert.equal(producers[0].executableResolved,expectedBinary,'Producer executable differs from frozen native binary');
 const producerId=producers[0].id;
 assert(!idle.some(r=>r.id===producerId&&['exit','error','throw'].includes(r.type)),'Producer retired during idle');
 const spawned=rows.find(r=>r.id===producerId&&r.type==='spawn');assert(spawned?.pid);
 assert(rows.some(r=>r.id===producerId&&r.type==='exit'),'Missing producer retirement');
 assert(!idle.some(r=>['throw','error'].includes(r.type)),'Idle subprocess failure');
 for(const row of idle.filter(r=>r.type==='sync-complete')){assert.equal(row.status,0,'Idle sync child failed');assert.equal(row.signal,null,'Idle sync child signaled');assert.equal(row.error,null,'Idle sync child error');}
 return {scope:'Node child_process APIs; no kernel-wide audit or internal queue inspection',producerPid:spawned.pid,producerStarts:producers.length,nativeEventInvocations:nativeCalls.length,idleAttempts:idle.filter(r=>r.type==='attempt'),events:rows.length,phases};
}
