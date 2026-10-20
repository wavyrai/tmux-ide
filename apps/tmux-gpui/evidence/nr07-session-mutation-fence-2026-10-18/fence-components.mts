import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createTmuxSessionMutationFence} from '../../../packages/daemon/src/lib/tmux-session-mutation-fence.ts';
import {liveSessionIdForNativeIdentity} from '../../../packages/daemon/src/terminal/protocol/live-session-identity.ts';
const root=mkdtempSync('/tmp/nr07-fence-'),socket=join(root,'s'),exe=resolve('.tasks/tmux38-compat/tmux-3.8/tmux');
const env={...process.env,HOME:root,PATH:'/usr/bin:/bin'};for(const k of Object.keys(env))if(k.startsWith('TMUX_')||k==='TMUX')delete env[k];
const result:any={calls:[]};
const run=(args:readonly string[])=>{const output=execFileSync(exe,['-S',socket,'-f','/dev/null',...args],{encoding:'utf8',timeout:5000,env}).trim();result.calls.push({args,output});return output;};
try{
run(['new-session','-d','-s','owned','/bin/sh']);
const [pid,id,created]=run(['list-sessions','-F','#{pid}\t#{session_id}\t#{session_created}']).split('\t');
result.identity={pid,id,created};
const format=`#{&&:#{==:#{session_id},${id}},#{==:#{session_created},${created}}}`;
result.components=Object.fromEntries(['#{session_id}|#{session_created}|#{session_name}',`#{==:#{session_id},${id}}`,`#{==:#{session_created},${created}}`,`#{==:#{session_id},#{session_id}}`,`#{==:#{session_created},#{session_created}}`].map(f=>[f,run(['display-message','-p','-t','=owned',f])]));
result.display=run(['display-message','-p','-t','=owned',format]);
result.ifShell=run(['if-shell','-t','=owned','-F',format,"display-message -p yes","display-message -p no"]);
const fence=createTmuxSessionMutationFence();
try{result.fenced=await fence.execute({liveSessionId:liveSessionIdForNativeIdentity(pid!,id!,created!),sessionName:'owned',run:async args=>run(args),mutate:async()=>fence.wrap(run)(['display-message','-p','#{session_name}'])});}catch(e){result.error=String(e);}
result.after=run(['list-sessions','-F','#{pid}\t#{session_id}\t#{session_created}']);
}finally{spawnSync(exe,['-S',socket,'kill-server'],{env,stdio:'ignore'});result.socketClosed=spawnSync(exe,['-S',socket,'list-sessions'],{env,stdio:'ignore'}).status!==0;rmSync(root,{recursive:true,force:true});writeFileSync('.tasks/native-reliability-mission/nr07-missing-agent/fence-components.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
