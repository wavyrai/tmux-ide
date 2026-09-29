import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export function boundIssuerReference(status, serverEpoch, connectionId) {
  assert.match(connectionId, /^[1-9][0-9]*$/);
  assert.equal(status.method,'native-journal');
  assert.match(serverEpoch,/^[0-9a-f-]{36}$/);
  const bytes=createHash('sha256').update(JSON.stringify(['tmux-ide-native-reference-v1',status.environmentId,status.serverScope.serverId,status.serverScope.generation,serverEpoch,'issuer',connectionId])).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function reconcile(evidence, issuers, pairs) {
  assert.equal(issuers.size,pairs,'one fresh external connection per pair');
  const counts=new Map([...issuers].map(x=>[x,{input:0,capture:0}]));
  const seen=new Set();let background=0;
  for(const e of evidence) {
    assert(!seen.has(e.interactionId),'duplicate evidence');seen.add(e.interactionId);
    if(e.observation.kind!=='native-journal'||e.actor.kind!=='native'||!counts.has(e.actor.issuerId)){background++;continue;}
    const row=counts.get(e.actor.issuerId);
    assert.equal(e.observation.parentCommandId,null,'unexpected authored descendant');
    if(e.effect.kind==='input-enqueued'&&e.observation.command==='send-keys')row.input++;
    else if(e.effect.kind==='snapshot-produced'&&e.observation.command==='capture-pane')row.capture++;
    else assert.fail('unknown or mismatched external effect');
  }
  for(const row of counts.values())assert.deepEqual(row,{input:1,capture:1});
  return {pairs,externalEffects:pairs*2,backgroundEvidence:background,totalEvidence:evidence.length};
}
export function caseCpu({wait4Seconds,fixtureSelfSeconds,serverSeconds,appSeconds}) {
  for(const n of [wait4Seconds,fixtureSelfSeconds,serverSeconds,appSeconds])assert(Number.isFinite(n)&&n>=0);
  assert(wait4Seconds>=fixtureSelfSeconds,'wait4 must include fixture self');
  // wait4 fixture includes its reaped daemon/workload children. Never add daemon ps CPU again.
  return {fixtureAndReapedCpuSeconds:wait4Seconds,fixtureSelfSeconds,reapedChildrenCpuSeconds:wait4Seconds-fixtureSelfSeconds,orphanServerCpuSeconds:serverSeconds,orphanAppCpuSeconds:appSeconds,totalCpuSeconds:wait4Seconds-fixtureSelfSeconds+serverSeconds+appSeconds};
}
