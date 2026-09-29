import test from 'node:test';import assert from 'node:assert/strict';
import {finalCaptureDrained} from './final-capture-drain.mjs';
const context={setupIssuer:'setup',pairIssuers:new Set(['seed','wake']),finalIssuer:'final'};
function effect(issuer,sequence,command='capture-pane',kind='snapshot-produced'){return {actor:{kind:'native',issuerId:issuer},observation:{kind:'native-journal',parentCommandId:null,command,cursor:{epoch:'epoch',sequence:String(sequence)}},effect:{kind}};}
const before=()=>[effect('setup',1),effect('seed',3,'send-keys','input-enqueued'),effect('seed',5),effect('wake',7,'send-keys','input-enqueued'),effect('wake',9)];
const status=sequence=>({cursor:{epoch:'epoch',sequence:String(sequence)}});
test('prior pair effects/status satisfied cannot end wake before final capture',()=>{
 const evidence=before();assert.throws(()=>finalCaptureDrained(evidence,status(10),context),/six/);
 evidence.push(effect('final',11));assert.equal(finalCaptureDrained(evidence,status(10),context),false);assert.equal(finalCaptureDrained(evidence,status(11),context),false);assert.equal(finalCaptureDrained(evidence,status(12),context),true);
});
test('status-first ordering still requires exact final effect',()=>{
 const evidence=before();assert.throws(()=>finalCaptureDrained(evidence,status(12),context),/six/);evidence.push(effect('final',11));assert.equal(finalCaptureDrained(evidence,status(12),context),true);
});
test('wrong issuer, effect, command, epoch, cursor or extra capture fail closed',()=>{
 for(const change of [e=>e.actor.issuerId='other',e=>e.effect.kind='input-enqueued',e=>e.observation.command='send-keys',e=>e.observation.cursor.epoch='other',e=>e.observation.cursor.sequence='9',e=>e.observation.parentCommandId='parent']){
  const e=effect('final',11);change(e);assert.throws(()=>finalCaptureDrained([...before(),e],status(12),context));
 }
 assert.throws(()=>finalCaptureDrained([...before(),effect('final',11),effect('another',13)],status(14),context));
 assert.throws(()=>finalCaptureDrained([...before(),effect('final',11)],status(14),context));
});
test('unavailable status is pending; unrelated prior capture cannot substitute final',()=>{
 assert.equal(finalCaptureDrained([...before(),effect('final',11)],null,context),false);
 assert.throws(()=>finalCaptureDrained([...before(),effect('setup',11)],status(12),context),/final capture/);
});
