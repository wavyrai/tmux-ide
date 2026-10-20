import {execFileSync} from 'node:child_process';
import {writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
const repo=process.cwd(), out=repo+'/.tasks/native-reliability-mission/nr04-actions';
await mkdir(out,{recursive:true});
const tmuxBin=repo+'/.tasks/tmux38-compat/tmux-3.8/tmux';
const cli=repo+'/.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const before=hash(repo+'/bin/cli.js');
for(const k of Object.keys(process.env)) if(k.startsWith('TMUX')||['NODE_OPTIONS','NODE_PATH'].includes(k)) delete process.env[k];
process.env.PATH=repo+'/.tasks/tmux38-compat/tmux-3.8:/private/tmp/tmux-ide-295-release-nkydyctm/tools:'+process.env.PATH;
const {createScratchFleet}=await import(repo+'/scripts/lib/product-fixtures/scratch-fleet.ts');
const {startDaemon}=await import(repo+'/scripts/lib/product-fixtures/daemon.ts');
const fleet=await createScratchFleet({sessions:1,windowsPerSession:1,slug:'nr04-actions',initialPaneMarker:'RIG_NR04_LEFT_CONTENT'});
const env={...process.env,...fleet.environment,TMUX_IDE_TMUX_SOCKET_PATH:fleet.socketPath,HOME:fleet.root+'/home',XDG_CONFIG_HOME:fleet.root+'/config',XDG_STATE_HOME:fleet.root+'/state',XDG_CACHE_HOME:fleet.root+'/cache',TMUX_IDE_TESTDRIVE_RUNTIME_DIR:fleet.root+'/tui',TMUX_IDE_TESTDRIVE_HOST_SESSION:'nr04-host-'+process.pid,TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH:fleet.root+'/host.sock',TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON:'1',TMUX_IDE_TESTDRIVE_CANONICAL_HOME:fleet.daemonInfoDir,TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR:fleet.daemonInfoDir};
await mkdir(env.HOME,{recursive:true,mode:0o700});
const tmux=(...a)=>execFileSync(tmuxBin,['-S',fleet.socketPath,...a],{env,encoding:'utf8',timeout:5000}).trim();
assert.equal(env.TMUX_IDE_TMUX_SOCKET_PATH,fleet.socketPath);
assert.ok(env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH.startsWith(fleet.root+'/'));
const drive=(...a)=>execFileSync(process.execPath,[repo+'/scripts/tui-testdrive.mjs',...a],{env,cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const snapshot=()=>tmux('list-panes','-t',fleet.sessionNames[0],'-F','#{pane_id}|#{pane_pid}|#{pane_birth_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}|#{window_zoomed_flag}').split('\n');
let daemon; const ownedPids=new Set();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const result={lane:'actual-source-OpenTUI',node:process.version,cliSha256:hash(cli),tmuxVersion:execFileSync(tmuxBin,['-V'],{encoding:'utf8'}).trim(),claims:'Calibration only; no GPUI or performance parity claim'};
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
 await command('Split right','split');result.split=await waitState(rows=>rows.length===2&&rows.every(row=>row.split('|')[8]==='41'));let splitFrame='';for(let i=0;i<50;i++){splitFrame=drive('capture');if(splitFrame.includes('2p')&&(splitFrame.split('\n')[2]?.match(/⋯/g)?.length??0)===2)break;await delay(100);}assert.ok(splitFrame.includes('2p')&&(splitFrame.split('\n')[2]?.match(/⋯/g)?.length??0)===2,'Rendered fleet count and both pane headers must reflect split');result.split=snapshot();result.renderedSplitReady=true;for(const row of result.split)ownedPids.add(Number(row.split('|')[1]));
 assert.deepEqual(result.split.map(row=>row.split('|').slice(3)),[['0','1','66','40','132','41','0'],['67','1','65','40','132','41','0']],'Split must have exact matched source shape');
 await writeFile(out+'/tui-split.txt',drive('capture'));assert.deepEqual(result.split[0].split('|').slice(0,2),result.initial[0].split('|').slice(0,2));
 drive('mouse','click','35','12');await delay(100);
 await command('Zoom pane','zoom');result.zoom=await waitState(rows=>rows[0].split('|')[9]==='1');assert.deepEqual(result.zoom[0].split('|').slice(0,9),result.initial[0].split('|').slice(0,9),'Zoom must expand the original pane to its original full geometry');await writeFile(out+'/tui-zoom.txt',drive('capture'));
 await command('Zoom pane','unzoom');result.unzoom=await waitState(rows=>rows[0].split('|')[9]==='0');await writeFile(out+'/tui-unzoom.txt',drive('capture'));
 assert.deepEqual(result.unzoom,result.split);
 result.expanded=result.split;
 drive('mouse','click','110','12');await delay(150);
 await command('Close pane','close');await delay(150);
 const confirmation=drive('capture');await writeFile(out+'/tui-close-confirmation.txt',confirmation);assert.ok(confirmation.includes('confirm'),'Destructive close must request confirmation');assert.equal(snapshot().length,2,'First activation must not close pane');
 drive('key','Enter');result.closed=await waitState(rows=>rows.length===1&&rows[0].split('|')[8]==='41');
 const newPid=Number(result.split[1].split('|')[1]);for(let i=0;i<30&&alive(newPid);i++)await delay(50);result.closedNewPidExited=!alive(newPid);assert.ok(result.closedNewPidExited);
 result.restored=result.closed;await writeFile(out+'/tui-closed.txt',drive('capture'));

 result.sourceIdentityPreserved=result.before[0].split('|').slice(0,2).join('|')===result.restored[0].split('|').slice(0,2).join('|');
 result.paneBirthIdSupported=result.initial.every(x=>x.split('|')[2].length>0);
 result.geometryChanged=result.initial.join('\n')!==result.expanded.join('\n');
 result.identityPreserved=result.initial[0].split('|').slice(0,3).join('|')===result.restored[0].split('|').slice(0,3).join('|');
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
 await writeFile(out+'/tui-actions.json',JSON.stringify(result,null,2)+'\n');}

console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
