import assert from 'node:assert/strict';
export function nativeStatusGuard(initial) {
 assert.equal(initial.method,'native-journal');
 assert.equal(initial.coverage,'declared-capabilities');
 assert.equal(initial.capabilityVersion,2);
 assert.equal(initial.lastGap?.reason,'uncertain-consume');
 assert.equal(initial.lastGap.range,null);
 assert(Number.isFinite(Date.parse(initial.lastGap.at)));
 assert.equal(initial.droppedCount,null,'Bootstrap history is unknown, never zero');
 const baseline=structuredClone(initial);
 return {baseline,check(next){
  for(const key of ['environmentId','serverScope','method','coverage','capabilityVersion','commands','effects','lastGap','droppedCount'])
   assert.deepEqual(next[key],baseline[key],`Owner status changed: ${key}`);
 }};
}
export function reconcileSetupCapture(evidence,issuer) {
 const rows=evidence.filter(e=>e.actor.kind==='native'&&e.actor.issuerId===issuer);
 assert.equal(rows.length,1,'Expected exactly one setup capture evidence');
 const e=rows[0];assert.equal(e.observation.kind,'native-journal');
 assert.equal(e.observation.parentCommandId,null);assert.equal(e.observation.command,'capture-pane');
 assert.equal(e.effect.kind,'snapshot-produced');return e.interactionId;
}
export function boundedDaemonOutput(daemon,limit=65536) {
 if(!daemon)return {available:false,reason:'daemon handle not returned'};
 const bytes=Buffer.from(daemon.output());
 return {available:true,totalBytes:bytes.length,retainedBytes:Math.min(bytes.length,limit),truncated:bytes.length>limit,tail:bytes.subarray(Math.max(0,bytes.length-limit)).toString('utf8')};
}
export function evidenceStatusBarrier(evidence,status,issuers){
 const relevant=evidence.filter(e=>e.actor.kind==='native'&&issuers.has(e.actor.issuerId));
 if(!relevant.length||!status?.cursor)return false;
 for(const e of relevant){const cursor=e.observation.cursor;
  assert(cursor,'Native evidence cursor required');
  assert.equal(cursor.epoch,status.cursor.epoch,'Seed epoch changed');
  if(BigInt(status.cursor.sequence)<BigInt(cursor.sequence))return false;
 }
 return true;
}
