import { createTmuxServerClient } from '../../../packages/daemon-client/src/tmux-server-client.ts';
import { writeFileSync } from 'node:fs';
const scope={serverId:`tmux-server.${'a'.repeat(32)}`,generation:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
let calls=0;
const client=createTmuxServerClient({baseUrl:'http://127.0.0.1:1',ownerToken:'fixture',hostClientId:'fixture',origin:'tmux-ide://app',fetch:async()=>{calls++;return Response.json({error:'The requested harness is not currently launchable.',code:'harness_unavailable'},{status:409});}},scope);
try {await client.createPane('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',{workspaceName:'main',kind:'agent',displayTitle:'Claude',harnessProfileId:'claude',role:'implementer',placement:{kind:'window'}},`live-session.${'a'.repeat(20)}`);throw Error('unexpected success');}
catch(error:any){const result={calls,observedCode:error.code,observedStatus:error.status,observedMessage:error.message,originalCodeRetained:error.code==='harness_unavailable',scope:'Injected transport refusal only; no actual missing binary or GUI exercised'};writeFileSync('.tasks/native-reliability-mission/nr07-missing-agent/result.json',JSON.stringify(result,null,2));console.log(result);}
finally{client.dispose();}
