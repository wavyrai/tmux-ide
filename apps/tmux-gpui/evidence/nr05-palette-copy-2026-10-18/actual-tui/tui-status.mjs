import {execFileSync} from 'node:child_process';
import {writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
const repo=process.cwd(), out=repo+'/.tasks/native-reliability-mission/nr05-palette-status/run-'+(process.argv[2]??'1');
assert.match(process.argv[2]??'1',/^[1-3]$/);
await mkdir(out,{recursive:false});
const tmuxBin=repo+'/.tasks/tmux38-compat/tmux-3.8/tmux';
const cli=repo+'/.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const before=hash(repo+'/bin/cli.js');
for(const k of Object.keys(process.env)) if(k.startsWith('TMUX')||['NODE_OPTIONS','NODE_PATH'].includes(k)) delete process.env[k];
process.env.PATH=repo+'/.tasks/tmux38-compat/tmux-3.8:/private/tmp/tmux-ide-295-release-nkydyctm/tools:'+process.env.PATH;
const {createScratchFleet}=await import(repo+'/scripts/lib/product-fixtures/scratch-fleet.ts');
const {startDaemon}=await import(repo+'/scripts/lib/product-fixtures/daemon.ts');
const fleet=await createScratchFleet({sessions:1,windowsPerSession:1,slug:'nr05-palette',initialPaneMarker:'RIG_NR04_LEFT_CONTENT'});
const env={...process.env,...fleet.environment,TMUX_IDE_TMUX_SOCKET_PATH:fleet.socketPath,HOME:fleet.root+'/home',XDG_CONFIG_HOME:fleet.root+'/config',XDG_STATE_HOME:fleet.root+'/state',XDG_CACHE_HOME:fleet.root+'/cache',TMUX_IDE_TESTDRIVE_RUNTIME_DIR:fleet.root+'/tui',TMUX_IDE_TESTDRIVE_HOST_SESSION:'nr04-host-'+process.pid,TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH:fleet.root+'/host.sock',TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON:'1',TMUX_IDE_TESTDRIVE_CANONICAL_HOME:fleet.daemonInfoDir,TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR:fleet.daemonInfoDir};
await mkdir(env.HOME,{recursive:true,mode:0o700});
const tmux=(...a)=>execFileSync(tmuxBin,['-S',fleet.socketPath,...a],{env,encoding:'utf8',timeout:5000}).trim();
assert.equal(env.TMUX_IDE_TMUX_SOCKET_PATH,fleet.socketPath);
assert.ok(env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH.startsWith(fleet.root+'/'));
const drive=(...a)=>execFileSync(process.execPath,[repo+'/scripts/tui-testdrive.mjs',...a],{env,cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const snapshot=()=>tmux('list-panes','-t',fleet.sessionNames[0],'-F','#{pane_id}|#{pane_pid}|#{pane_birth_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}|#{window_zoomed_flag}').split('\n');
let daemon; const ownedPids=new Set();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const result={lane:'actual-source-OpenTUI',node:process.version,cliSha256:hash(cli),tmuxVersion:execFileSync(tmuxBin,['-V'],{encoding:'utf8'}).trim(),sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),claims:'TUI transient palette status; no native GUI or timing performance claim'};
try{

 result.before=snapshot(); ownedPids.add(Number(tmux('display-message','-p','#{pid}')));for(const row of result.before)ownedPids.add(Number(row.split('|')[1]));
 daemon=await startDaemon({...fleet,environment:{...fleet.environment,HOME:env.HOME,XDG_CONFIG_HOME:env.XDG_CONFIG_HOME,XDG_STATE_HOME:env.XDG_STATE_HOME,XDG_CACHE_HOME:env.XDG_CACHE_HOME}},{cliPath:cli});
 ownedPids.add(daemon.record.pid);
 result.launch=drive('start','--source','--target',fleet.sessionNames[0],'--cols','160','--rows','44');
 for(const pid of execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'list-panes','-a','-F','#{pane_pid}'],{env,encoding:'utf8'}).trim().split('\n'))ownedPids.add(Number(pid));
 ownedPids.add(Number(execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'display-message','-p','#{pid}'],{env,encoding:'utf8'}).trim()));
 let frame='';
 for(let i=0;i<40;i++){await delay(500);frame=drive('capture');if(frame.includes('RIG_NR04_LEFT_CONTENT')) break;}
 await writeFile(out+'/tui-initial.txt',frame);await writeFile(out+'/tui-initial.ansi',drive('capture','--ansi'));
 result.initial=snapshot(); result.renderedBothMarkers=frame.includes('RIG_NR04_LEFT_CONTENT');
 assert.ok(result.renderedBothMarkers,'Actual TUI frame must show both source markers');
 const waitState=async(predicate)=>{let rows;for(let i=0;i<50;i++){await delay(100);rows=snapshot();if(predicate(rows))return rows;}throw Error('Action did not reach expected source state: '+JSON.stringify(rows));};
 const command=async(label,tag)=>{drive('key','F5');await delay(100);drive('text',label);await delay(150);const menu=drive('capture');await writeFile(out+'/tui-menu-'+tag+'.txt',menu);assert.ok(menu.includes(label),'Actual palette must render requested action');assert.ok(!menu.includes('Open a live session first')&&!menu.includes('Select a live pane first'),'Action must be enabled on current live topology');drive('key','Enter');};
 // Intentionally omit source/catalog readiness waits between Split and Zoom.
 await command('Split right','split');
 drive('key','F5');
 let menu='';
 for(let i=0;i<20;i++){menu=drive('capture');if(menu.includes('Command palette'))break;await delay(20);}
 if(!menu.includes('Command palette')){drive('key','F5');for(let i=0;i<20;i++){menu=drive('capture');if(menu.includes('Command palette'))break;await delay(20);}}
 await writeFile(out+'/tui-palette-admission.txt',menu);
 assert.ok(menu.includes('Command palette'),'Palette must be visibly open before filter text');
 drive('text','Zoom pane');
 for(let i=0;i<20;i++){menu=drive('capture');if(menu.includes('Zoom / unzoom pane'))break;await delay(20);}
 await writeFile(out+'/tui-immediate-menu.txt',menu);
 assert.ok(menu.includes('Zoom / unzoom pane'),'Requested palette action must be visible');
 const reasons=['Terminal is updating. Try again shortly.','Opening terminal…','Open a live session first','Select a live pane first'];
 const observedReason=reasons.find(reason=>menu.includes(reason))??null;
 result.observedReason=observedReason;
 result.sourceAtPalette=snapshot();for(const row of result.sourceAtPalette)ownedPids.add(Number(row.split('|')[1]));
 result.transientObserved=observedReason!==null;
 if(!observedReason){result.outcome='unobserved';result.pass=false;}
 else {
  result.contextCorrect=observedReason==='Terminal is updating. Try again shortly.';
  // A captured disabled presentation is not assumed frozen: any zoom here is
  // recorded as a race/failed no-effect proof, never called disabled success.
  drive('key','Enter');
  const blockedFrame=drive('capture');await writeFile(out+'/tui-after-blocked-enter.txt',blockedFrame);
  result.afterBlockedEnter=snapshot();
  result.noZoomWhileBlocked=result.afterBlockedEnter.every(row=>row.split('|')[9]==='0');
  assert.ok(result.noZoomWhileBlocked,'Disabled activation must not zoom (or state raced capture)');
  let enabled=false;
  for(let i=0;i<80;i++){
   menu=drive('capture');
   if(menu.includes('Zoom / unzoom pane')&&!reasons.some(reason=>menu.includes(reason))){enabled=true;break;}
   await delay(50);
  }
  await writeFile(out+'/tui-enabled-menu.txt',menu);assert.ok(enabled,'Palette action must become enabled');
  drive('key','Enter');result.zoom=await waitState(rows=>rows.some(row=>row.split('|')[9]==='1'));
  await writeFile(out+'/tui-zoom.txt',drive('capture'));
  drive('text',"printf 'RIG_NR05_FRESH_INPUT\\n'");drive('key','Enter');
  let final='';for(let i=0;i<60;i++){final=drive('capture');if(tmux('capture-pane','-p','-t',result.initial[0].split('|')[0]).split('\n').includes('RIG_NR05_FRESH_INPUT')&&final.includes('RIG_NR05_FRESH_INPUT'))break;await delay(50);}
  await writeFile(out+'/tui-fresh-input.txt',final);
  result.freshInput=final.includes('RIG_NR05_FRESH_INPUT')&&tmux('capture-pane','-p','-t',result.initial[0].split('|')[0]).split('\n').includes('RIG_NR05_FRESH_INPUT');
  assert.ok(result.freshInput);result.outcome=result.contextCorrect?'verified':'old-context-observed';result.pass=result.contextCorrect;
 }
}catch(e){result.pass=false;result.error=String(e);try{await writeFile(out+'/tui-failure.txt',drive('capture'));}catch{} }
finally{
 try{for(const row of snapshot())ownedPids.add(Number(row.split('|')[1]));}catch{}
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
 await writeFile(out+'/tui-status.json',JSON.stringify(result,null,2)+'\n');}

console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
