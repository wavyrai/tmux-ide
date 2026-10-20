import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const repo=process.cwd(), out=repo+'/.tasks/native-reliability-mission/nr04-divider';
const cli=repo+'/.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js';
const tmuxBin=repo+'/.tasks/tmux38-compat/tmux-3.8/tmux';
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const protectedHash=await hash(repo+'/bin/cli.js');
for(const key of Object.keys(process.env)) if(key.startsWith('TMUX')||['NODE_OPTIONS','NODE_PATH'].includes(key)) delete process.env[key];
process.env.PATH=repo+'/.tasks/tmux38-compat/tmux-3.8:'+process.env.PATH;
const {createScratchFleet}=await import(repo+'/scripts/lib/product-fixtures/scratch-fleet.ts');
const {startDaemon}=await import(repo+'/scripts/lib/product-fixtures/daemon.ts');
const {stopFixtureChild}=await import(repo+'/apps/tmux-gpui/bridge/fixture-child.mjs');
const fleet=await createScratchFleet({sessions:1,windowsPerSession:1,slug:'nr04-divider',initialPaneMarker:'RIG_NR04_LEFT_CONTENT'});
const env={...process.env,...fleet.environment,TMUX_IDE_TMUX_SOCKET_PATH:fleet.socketPath};
const tmux=(...args)=>execFileSync(tmuxBin,['-S',fleet.socketPath,...args],{env,encoding:'utf8',timeout:5000}).trim();
const geometry=()=>tmux('list-panes','-t',fleet.sessionNames[0],'-F','#{pane_id}|#{pane_pid}|#{pane_birth_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}|#{window_zoomed_flag}').split('\n');
const identities=rows=>rows.map(row=>row.split('|').slice(0,3).join('|'));
let daemon,helper,latest,buffer='',stderr='',fatal,closing=false;
const ownedPids=new Set();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const result={lane:'actual-source-GPUI-bridge',node:process.version,cliSha256:await hash(cli),tmuxVersion:execFileSync(tmuxBin,['-V'],{encoding:'utf8'}).trim(),claims:'Bridge grid calibration; no native physical GUI or performance parity claim'};
const wait=async(predicate,label)=>{const end=Date.now()+30000;while(!predicate()){if(fatal)throw fatal;assert.ok(Date.now()<end,label+' deadline');await delay(25);}};
const send=value=>helper.stdin.write(JSON.stringify(value)+'\n');
const text=()=>latest?.snapshot?.grid.map(row=>row.cells.map(cell=>cell.grapheme).join('')).join('\n')??'';
const both=()=>text().includes('RIG_NR04_LEFT_CONTENT')&&text().includes('RIG_NR04_RIGHT_CONTENT');
try{
 tmux('split-window','-h','-d','-t',fleet.sessionNames[0],"printf 'RIG_NR04_RIGHT_CONTENT\\n'; exec /bin/sh -i");
 result.before=geometry();
 ownedPids.add(Number(tmux('display-message','-p','-t',fleet.sessionNames[0],'#{pid}')));
 for(const row of result.before)ownedPids.add(Number(row.split('|')[1]));
 daemon=await startDaemon(fleet,{cliPath:cli});
 ownedPids.add(daemon.record.pid);
 helper=spawn(process.execPath,['--import','tsx',repo+'/apps/tmux-gpui/bridge/browser.ts','--local'],{env,cwd:repo,stdio:['pipe','pipe','pipe']});
 ownedPids.add(helper.pid);
 helper.on('error',()=>fatal=new Error('Owned helper spawn failed'));
 helper.on('exit',()=>{if(!closing)fatal=new Error('Owned helper exited');});
 for(const stream of [helper.stdin,helper.stdout,helper.stderr])stream.on('error',()=>{if(!closing)fatal=new Error('Owned stream failed');});
 helper.stderr.on('data',data=>stderr=(stderr+data).slice(-8192));
 helper.stdout.on('data',data=>{try{buffer+=data;assert.ok(Buffer.byteLength(buffer)<=8*1024*1024);let end;while((end=buffer.indexOf('\n'))>=0){latest=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);}}catch{fatal=new Error('Invalid bounded publication');}});
 send({type:'presence',active:true,revision:1});
 await wait(()=>latest?.home?.phase==='live'&&latest.sessions.length===1,'Home');
 send({type:'session',request:1,id:latest.sessions[0].id});
 await wait(()=>latest?.request===1&&latest.sessionCatalogComplete&&latest.preferredPane,'catalog');
 const pane=latest.preferredPane;
 send({type:'pane',request:2,id:pane});
 await wait(()=>latest?.request===2&&latest.selectedPane===pane&&latest.snapshot&&latest.inputReady,'input-ready');
 result.request=2;
 send({type:'input',request:2,id:pane,input:{kind:'resize',data:{cols:132,rows:41}}});
 await wait(()=>latest.snapshot?.cols===132&&latest.snapshot?.rows===41&&latest.inputReady&&both()&&latest.splitLayout?.splits.length===1&&latest.splitLayout.splits[0].boundary===66,'calibrated split');
 const check=async(name,boundary)=>{
  await wait(()=>{
   const rows=geometry().map(row=>row.split('|'));
   return rows.length===2&&Number(rows[0][5])===boundary&&Number(rows[1][3])===boundary+1&&Number(rows[1][5])===131-boundary&&rows.every(row=>row[4]==='1'&&row[6]==='40'&&row[7]==='132'&&row[8]==='41')&&latest.snapshot?.cols===132&&latest.snapshot?.rows===41&&both();
  },name+' exact geometry and published content');
  result[name]=geometry();assert.deepEqual(identities(result.before),identities(result[name]));
  await writeFile(out+'/gpui-'+name+'.txt',text());
 };
 await check('initial',66);
 const begin=()=>{
  const resource=latest.splitLayout, split=resource.splits[0],gesture=randomUUID();
  send({type:'split-gesture',phase:'begin',request:2,gesture,target:{window:resource.window,layoutId:resource.layoutId,splitId:split.splitId,boundary:split.boundary},axis:split.axis});
  return gesture;
 };
 const gesture=begin();
 send({type:'split-gesture',phase:'move',request:2,gesture,boundary:69});
 await wait(()=>latest.splitGesture?.gesture===gesture&&['dragging','failed'].includes(latest.splitGesture.phase)&&latest.splitGesture.boundary===69,'move acknowledgement');
 assert.equal(latest.splitGesture.phase,'dragging');
 await check('moved',69);result.movedBeforeRelease=true;
 send({type:'split-gesture',phase:'move',request:2,gesture,boundary:72});
 send({type:'split-gesture',phase:'release',request:2,gesture,boundary:75});
 await wait(()=>latest.splitGesture?.gesture===gesture&&['settled','failed'].includes(latest.splitGesture.phase),'release acknowledgement');
 assert.equal(latest.splitGesture.phase,'settled');assert.equal(latest.splitGesture.boundary,75);
 await check('released',75);
 await wait(()=>latest.inputReady&&latest.splitLayout?.splits[0].boundary===75,'fresh restore authority');
 const restore=begin();
 send({type:'split-gesture',phase:'move',request:2,gesture:restore,boundary:66});
 send({type:'split-gesture',phase:'release',request:2,gesture:restore,boundary:66});
 await wait(()=>latest.splitGesture?.gesture===restore&&['settled','failed'].includes(latest.splitGesture.phase),'restore acknowledgement');
 assert.equal(latest.splitGesture.phase,'settled');assert.equal(latest.splitGesture.boundary,66);
 await check('restored',66);assert.deepEqual(result.initial,result.restored);
 await wait(()=>latest.inputReady&&latest.selectedPane===pane,'restored input authority');
 result.publishedBothMarkers=true;
 result.paneBirthIdSupported=result.initial.every(row=>row.split('|')[2].length>0);
 result.identityPreserved=true;result.geometryRestored=true;
 send({type:'input',request:2,id:pane,input:{kind:'text',data:"printf 'RIG_NR04_GPUI_FRESH_INPUT\\n'"}});
 send({type:'input',request:2,id:pane,input:{kind:'key',data:'Enter'}});
 await wait(()=>text().split('\n').some(line=>line.trim()==='RIG_NR04_GPUI_FRESH_INPUT'),'fresh published input');
 result.freshInput=true;
 const runtime=tmux('list-panes','-t',fleet.sessionNames[0],'-F','#{pane_id}|#{@tmux_ide_pane_id}').split('\n').map(row=>row.split('|')).find(row=>row[1]===pane)?.[0];assert.ok(runtime);
 const actual=tmux('capture-pane','-p','-t',runtime);
 result.sourceFreshInput=actual.split('\n').some(line=>line.trim()==='RIG_NR04_GPUI_FRESH_INPUT');
 assert.ok(result.sourceFreshInput);
 await writeFile(out+'/gpui-fresh-input.txt',text());
 result.pass=true;
}catch(error){result.pass=false;result.error=String(error);result.last={split:latest?.splitLayout,gesture:latest?.splitGesture,cols:latest?.snapshot?.cols,rows:latest?.snapshot?.rows,input:latest?.inputReady};try{result.lastGeometry=geometry();await writeFile(out+'/gpui-failure.txt',text());}catch{}}
finally{
 closing=true;result.cleanupErrors=[];
 for(const [label,stop] of [['helper',()=>helper&&stopFixtureChild(helper)],['daemon',()=>daemon&&daemon.stop()],['fleet',()=>fleet.dispose()]]){
  try{await stop();}catch{result.cleanupErrors.push(label+' cleanup failed');}
 }
 const deadline=Date.now()+5000;
 while([...ownedPids].some(alive)&&Date.now()<deadline)await delay(50);
 result.remainingOwnedPids=[...ownedPids].filter(alive);result.ownedPidCount=ownedPids.size;
 result.cleanup=result.cleanupErrors.length===0&&result.remainingOwnedPids.length===0;
 if(!result.cleanup){result.privateRoot=fleet.root;result.pass=false;}
 result.protectedCliUnchanged=protectedHash===await hash(repo+'/bin/cli.js');
 if(!result.protectedCliUnchanged)result.pass=false;
 await writeFile(out+'/gpui-divider.json',JSON.stringify(result,null,2)+'\n');await writeFile(out+'/gpui-divider.stderr',stderr);
}
console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
