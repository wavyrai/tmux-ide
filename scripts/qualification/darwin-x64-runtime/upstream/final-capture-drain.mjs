import assert from 'node:assert/strict';
/** Fixed two-pair idle fixture: setup capture + seed/wake pairs + final capture. */
export function finalCaptureDrained(evidence,status,{setupIssuer,pairIssuers,finalIssuer}){
 assert.equal(pairIssuers.size,2);
 const allowed=new Set([setupIssuer,...pairIssuers,finalIssuer]);assert.equal(allowed.size,4,'Distinct setup/pair/final issuers required');
 assert.equal(evidence.length,6,'Exact six effects required');
 assert(evidence.every(e=>e.actor.kind==='native'&&allowed.has(e.actor.issuerId)),'Unexpected issuer');
 const rows=evidence.filter(e=>e.actor.issuerId===finalIssuer);assert.equal(rows.length,1,'Exact final capture required');
 const e=rows[0];assert.equal(e.observation.kind,'native-journal');assert.equal(e.observation.parentCommandId,null);
 assert.equal(e.observation.command,'capture-pane');assert.equal(e.effect.kind,'snapshot-produced');
 assert.equal(e.observation.cursor.sequence,'11','Final capture must follow the exact prior commands');
 if(!status?.cursor)return false;
 assert.equal(status.cursor.epoch,e.observation.cursor.epoch,'Final capture epoch changed');
 if(BigInt(status.cursor.sequence)<12n)return false;
 assert.equal(status.cursor.sequence,'12','Unexpected records beyond final capture');
 return true;
}
