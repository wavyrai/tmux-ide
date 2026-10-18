import {execFileSync} from 'node:child_process';
import {writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
const repo=process.cwd(), out=repo+'/.tasks/native-reliability-mission/nr04-busy';
await mkdir(out,{recursive:true});
const tmuxBin=repo+'/.tasks/tmux38-compat/tmux-3.8/tmux';
const cli=repo+'/.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const before=hash(repo+'/bin/cli.js');
for(const k of Object.keys(process.env)) if(k.startsWith('TMUX')||['NODE_OPTIONS','NODE_PATH'].includes(k)) delete process.env[k];
process.env.PATH=repo+'/.tasks/tmux38-compat/tmux-3.8:/private/tmp/tmux-ide-295-release-nkydyctm/tools:'+process.env.PATH;
const {createScratchFleet}=await import(repo+'/scripts/lib/product-fixtures/scratch-fleet.ts');
const {startDaemon}=await import(repo+'/scripts/lib/product-fixtures/daemon.ts');
const fleet=await createScratchFleet({sessions:1,windowsPerSession:1,slug:'nr04-busy',initialPaneMarker:'RIG_NR04_LEFT_CONTENT'});
const env={...process.env,...fleet.environment,TMUX_IDE_TMUX_SOCKET_PATH:fleet.socketPath,HOME:fleet.root+'/home',XDG_CONFIG_HOME:fleet.root+'/config',XDG_STATE_HOME:fleet.root+'/state',XDG_CACHE_HOME:fleet.root+'/cache',TMUX_IDE_TESTDRIVE_RUNTIME_DIR:fleet.root+'/tui',TMUX_IDE_TESTDRIVE_HOST_SESSION:'nr04-host-'+process.pid,TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH:fleet.root+'/host.sock',TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON:'1',TMUX_IDE_TESTDRIVE_CANONICAL_HOME:fleet.daemonInfoDir,TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR:fleet.daemonInfoDir};
await mkdir(env.HOME,{recursive:true,mode:0o700});
const tmux=(...a)=>execFileSync(tmuxBin,['-S',fleet.socketPath,...a],{env,encoding:'utf8',timeout:5000}).trim();
assert.equal(env.TMUX_IDE_TMUX_SOCKET_PATH,fleet.socketPath);
assert.ok(env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH.startsWith(fleet.root+'/'));
const drive=(...a)=>execFileSync(process.execPath,[repo+'/scripts/tui-testdrive.mjs',...a],{env,cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const snapshot=()=>tmux('list-panes','-t',fleet.sessionNames[0],'-F','#{pane_id}|#{pane_pid}|#{pane_birth_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}|#{window_zoomed_flag}').split('\n');
let daemon; const ownedPids=new Set();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const result={lane:'actual-source-OpenTUI',node:process.version,cliSha256:hash(cli),tmuxVersion:execFileSync(tmuxBin,['-V'],{encoding:'utf8'}).trim(),claims:'Actual TUI busy divider correctness only; no GPUI or performance parity claim'};
try{
 tmux('split-window','-h','-d','-t',fleet.sessionNames[0],"printf 'RIG_NR04_RIGHT_CONTENT\\n'; exec /bin/sh -i");
 result.before=snapshot(); ownedPids.add(Number(tmux('display-message','-p','#{pid}')));for(const row of result.before)ownedPids.add(Number(row.split('|')[1]));
 daemon=await startDaemon({...fleet,environment:{...fleet.environment,HOME:env.HOME,XDG_CONFIG_HOME:env.XDG_CONFIG_HOME,XDG_STATE_HOME:env.XDG_STATE_HOME,XDG_CACHE_HOME:env.XDG_CACHE_HOME}},{cliPath:cli});
 ownedPids.add(daemon.record.pid);
 result.launch=drive('start','--source','--target',fleet.sessionNames[0],'--cols','160','--rows','44');
 for(const pid of execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'list-panes','-a','-F','#{pane_pid}'],{env,encoding:'utf8'}).trim().split('\n'))ownedPids.add(Number(pid));
 ownedPids.add(Number(execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'display-message','-p','#{pid}'],{env,encoding:'utf8'}).trim()));
 let frame='';
 for(let i=0;i<40;i++){await delay(500);frame=drive('capture');if(frame.includes('RIG_NR04_LEFT_CONTENT')&&frame.includes('RIG_NR04_RIGHT_CONTENT')) break;}
 await writeFile(out+'/tui-initial.txt',frame);await writeFile(out+'/tui-initial.ansi',drive('capture','--ansi'));
 result.initial=snapshot(); result.renderedBothMarkers=frame.includes('RIG_NR04_LEFT_CONTENT')&&frame.includes('RIG_NR04_RIGHT_CONTENT');
 assert.ok(result.renderedBothMarkers,'Actual TUI frame must show both source markers');
 const producer=out+'/producer.sh';result.producerSha256=hash(producer);
 const privateProducer=fleet.root+'/busy.sh';await writeFile(privateProducer,readFileSync(producer));assert.equal(hash(privateProducer),result.producerSha256);
 const leftPane=result.initial[0].split('|')[0];
 const sourceText=()=>tmux('capture-pane','-p','-t',leftPane);
 const tick=()=>{const text=sourceText();return {tick:Number(text.match(/NR04_TICK_(\d{3})/)?.[1]??0),done:text.includes('NR04_BUSY_DONE')};};
 tmux('send-keys','-t',leftPane,'-l','sh '+privateProducer);tmux('send-keys','-t',leftPane,'Enter');
 for(let i=0;i<50&&tick().tick===0;i++)await delay(25);
 assert.ok(tick().tick>0&&tick().tick<200&&!tick().done);
 const initialLeft=Number(result.initial[0].split('|')[5]);
 const contentX=frame.split('\n').find(line=>line.includes('RIG_NR04_LEFT_CONTENT')).indexOf('RIG_NR04_LEFT_CONTENT');
 const dividerX=contentX+initialLeft, y=12;
 result.pointer={contentX,dividerX,y,units:'zero-based host cells'};result.steps=[];
 for(const [from,to,delta] of [[dividerX,dividerX+3,3],[dividerX+3,dividerX+9,9],[dividerX+9,dividerX,0]]){
   const beforeTick=tick();assert.ok(beforeTick.tick>0&&beforeTick.tick<200&&!beforeTick.done);
   drive('mouse','drag',String(from),String(y),String(to),String(y));
   let rows;
   for(let attempt=0;attempt<30;attempt++){await delay(100);rows=snapshot();if(Number(rows[0].split('|')[5])===initialLeft+delta)break;}
   const afterTick=tick();result.steps.push({from,to,expectedLeftWidth:initialLeft+delta,rows,beforeTick,afterTick});assert.ok(afterTick.tick>beforeTick.tick&&afterTick.tick<200&&!afterTick.done,'Producer must progress during every gesture');
   await writeFile(out+'/tui-step-'+result.steps.length+'.txt',drive('capture'));
   assert.equal(Number(rows[0].split('|')[5]),initialLeft+delta,'Divider must commit exact target width');
   assert.equal(Number(rows[1].split('|')[5]),Number(result.initial[1].split('|')[5])-delta);
   assert.equal(Number(rows[1].split('|')[3]),initialLeft+delta+1);
   for(const [i,row] of rows.entries())assert.ok(tmux('capture-pane','-p','-t',row.split('|')[0]).split('\n').includes(i===0?'RIG_NR04_LEFT_CONTENT':'RIG_NR04_RIGHT_CONTENT'),'Source marker preserved after each drag');
   assert.deepEqual(rows.map(row=>row.split('|').slice(0,2)),result.initial.map(row=>row.split('|').slice(0,2)));
   assert.deepEqual(rows.map(row=>row.split('|').slice(6)),result.initial.map(row=>row.split('|').slice(6)));
 }
 result.expanded=result.steps[1].rows;result.restored=snapshot();await writeFile(out+'/tui-restored.txt',drive('capture'));
 for(let i=0;i<150&&!tick().done;i++)await delay(100);
 result.finalProducer=tick();assert.deepEqual(result.finalProducer,{tick:200,done:true});
 let busyFrame='';for(let i=0;i<30;i++){busyFrame=drive('capture');if(busyFrame.includes('NR04_TICK_200')&&busyFrame.includes('NR04_BUSY_DONE'))break;await delay(100);}
 await writeFile(out+'/tui-busy-final.txt',busyFrame);assert.ok(busyFrame.includes('NR04_TICK_200')&&busyFrame.includes('NR04_BUSY_DONE'),'Actual TUI must render final producer state');
 result.sourceIdentityPreserved=result.before.map(x=>x.split('|').slice(0,2).join('|')).join('\n')===result.restored.map(x=>x.split('|').slice(0,2).join('|')).join('\n');
 result.paneBirthIdSupported=result.initial.every(x=>x.split('|')[2].length>0);
 result.geometryChanged=result.initial.join('\n')!==result.expanded.join('\n');
 result.identityPreserved=result.initial.map(x=>x.split('|').slice(0,3).join('|')).join('\n')===result.restored.map(x=>x.split('|').slice(0,3).join('|')).join('\n');
 result.geometryRestored=result.initial.join('\n')===result.restored.join('\n');
 drive('text',"printf 'RIG_NR04_FRESH_INPUT\\n'");drive('key','Enter');await delay(800);
 const final=drive('capture');await writeFile(out+'/tui-fresh-input.txt',final);result.freshInput=final.includes('RIG_NR04_FRESH_INPUT');
 result.sourceFreshInput=tmux('capture-pane','-p','-t',result.initial[0].split('|')[0]).split('\n').includes('RIG_NR04_FRESH_INPUT');
 assert.ok(result.identityPreserved&&result.sourceIdentityPreserved&&result.geometryChanged&&result.geometryRestored&&result.freshInput&&result.sourceFreshInput); result.pass=true;
}catch(e){result.pass=false;result.error=String(e);try{await writeFile(out+'/tui-failure.txt',drive('capture'));}catch{} }
finally{
 result.cleanupErrors=[];
 try{drive('stop');}catch(e){result.cleanupErrors.push('testdrive-stop: '+String(e));}
 try{execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'kill-server'],{stdio:'pipe',timeout:5000});}catch(e){if(!/no server running|No such file or directory/.test(String(e.stderr)))result.cleanupErrors.push('host-stop: '+String(e));}
 try{if(daemon)await daemon.stop();}catch(e){result.cleanupErrors.push('daemon-stop: '+String(e));}
 try{await fleet.dispose();}catch(e){result.cleanupErrors.push('fleet-dispose: '+String(e));}
 for(let i=0;i<60&&[...ownedPids].some(alive);i++)await delay(50);
 result.remainingOwnedPids=[...ownedPids].filter(alive);result.ownedPidCount=ownedPids.size;
 result.protectedCliUnchanged=before===hash(repo+'/bin/cli.js');
 result.cleanup=result.cleanupErrors.length===0&&result.remainingOwnedPids.length===0;
 result.pass=Boolean(result.pass&&result.cleanup&&result.protectedCliUnchanged);
 await writeFile(out+'/tui-divider.json',JSON.stringify(result,null,2)+'\n');}

console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
