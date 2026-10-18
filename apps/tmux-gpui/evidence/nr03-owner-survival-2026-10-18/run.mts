import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createNativeTmuxServerOwner} from '../../../packages/daemon/src/lib/tmux-server-owner.ts';
const root=mkdtempSync('/tmp/nr03-owner-'),socket=join(root,'s');
const exe=join(process.cwd(),'.tasks/tmux38-compat/tmux-3.8/tmux');
const run=(args:string[])=>execFileSync(exe,['-S',socket,'-f','/dev/null',...args],{encoding:'utf8',env:{...process.env,TMUX:''}}).trim();
const result:any={pass:false};let owner:any;
const wait=async(fn:()=>boolean)=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('deadline');await new Promise(r=>setTimeout(r,20));}};
try{
run(['new-session','-d','-s','shared','-n','original','/bin/sh']);
run(['set-option','-w','-t','shared:0','@tmux_ide_window_id','win.shared']);run(['set-option','-p','-t','shared:0.0','@tmux_ide_pane_id','pane.shared']);
owner=await createNativeTmuxServerOwner({environmentId:randomUUID(),serverId:`tmux-server.${'a'.repeat(32)}`,generation:randomUUID(),tmuxAuthority:{executablePath:exe,socketSelector:{kind:'path',path:socket}},stateDirectory:join(root,'state'),webSocketUrl:'ws://127.0.0.1:1/v2/terminal/pane-streams/redeem'});
const registry=owner.sessionRuntimeRegistry; const a=registry.connect('shared','test','a');let first:any;
await a.subscribeReplica('pane.shared',(u:any)=>{first=u;});assert(first);
const before=registry.qualificationSnapshot();await a.close();const idle=registry.qualificationSnapshot();
const replica=idle.sessions[0].replicas['pane.shared'];assert.equal(idle.sessions[0].consumers,0);assert.equal(replica.listeners.canonical,0);assert.equal(replica.listeners.raw,0);assert.equal(replica.listeners.upstream,1);
run(['send-keys','-t','shared:0.0',"printf 'NR03_OWNER_ALIVE\\n'",'Enter']);
await wait(()=>registry.qualificationSnapshot().sessions[0].replicas['pane.shared'].revision>replica.revision);
const updated=registry.qualificationSnapshot().sessions[0].replicas['pane.shared'];
const b=registry.connect('shared','test','b');let second:any;await b.subscribeReplica('pane.shared',(u:any)=>{second=u;});await wait(()=>!!second);
assert.equal(second.incarnation,first.incarnation);assert.equal(second.stateHash,updated.stateHash);assert(second.snapshot.grid.some((r:any)=>r.cells.map((c:any)=>c.grapheme).join('').includes('NR03_OWNER_ALIVE')));await b.close();
result.pass=true;result.before=before.sessions[0].replicas['pane.shared'];result.idle=replica;result.sameIncarnation=true;result.currentStateHash=true;result.outputWhileUnsubscribed=true;result.updated=updated;
}catch(e){result.error=String(e);}finally{await owner?.dispose();spawnSync(exe,['-S',socket,'kill-server'],{env:{...process.env,TMUX:''},stdio:'ignore'});result.socketClosed=spawnSync(exe,['-S',socket,'list-sessions'],{env:{...process.env,TMUX:''},stdio:'ignore'}).status!==0;rmSync(root,{recursive:true,force:true});writeFileSync('.tasks/native-reliability-mission/nr03-owner-survival/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
