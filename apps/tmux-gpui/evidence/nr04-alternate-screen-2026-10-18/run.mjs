import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,statSync,accessSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const repo=process.cwd(),lane=process.argv[2];assert.ok(['plain','tui','gpui'].includes(lane));
const cliArgument=repo+'/.tasks/native-reliability-mission/installer-lifecycle/private-w5f4o2hz/installed/lib/node_modules/tmux-ide/bin/cli.js',tuiArgument=repo+'/.tasks/native-reliability-mission/packaged-paste/package-297-8yx0htjo/source/packages/daemon/dist/tui/tmux-ide-tui';
assert.ok(cliArgument?.startsWith('/')&&tuiArgument?.startsWith('/'),'Explicit absolute CLI and compiled TUI paths required');
const cli=realpathSync(cliArgument),compiledTui=realpathSync(tuiArgument);
assert.ok(statSync(cli).isFile()&&statSync(compiledTui).isFile());accessSync(compiledTui,constants.X_OK);
assert.ok(cli.endsWith('/bin/cli.js'));const packageRoot=cli.slice(0,-'/bin/cli.js'.length);
const packageMetadata=JSON.parse(readFileSync(packageRoot+'/package.json','utf8'));assert.equal(packageMetadata.name,'tmux-ide');assert.equal(packageMetadata.version,'2.9.7');
const out=repo+'/.tasks/native-reliability-mission/nr04-alternate-screen/'+lane;mkdirSync(out);
const tmuxBin=repo+'/.tasks/tmux38-compat/tmux-3.8/tmux';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const protectedHash=hash(repo+'/bin/cli.js');const cliHash=hash(cli),compiledTuiHash=hash(compiledTui);
for(const key of Object.keys(process.env))if(key.startsWith('TMUX')||['NODE_OPTIONS','NODE_PATH'].includes(key))delete process.env[key];
process.env.PATH=repo+'/.tasks/tmux38-compat/tmux-3.8:/private/tmp/tmux-ide-295-release-nkydyctm/tools:'+process.env.PATH;
const {createScratchFleet}=await import(repo+'/scripts/lib/product-fixtures/scratch-fleet.ts');
const {startDaemon}=await import(repo+'/scripts/lib/product-fixtures/daemon.ts');
const {stopFixtureChild}=await import(repo+'/apps/tmux-gpui/bridge/fixture-child.mjs');
const fleet=await createScratchFleet({sessions:1,windowsPerSession:1,slug:'nr04-paste-'+lane});
const env={...process.env,...fleet.environment,TMUX_IDE_TMUX_SOCKET_PATH:fleet.socketPath,HOME:fleet.root+'/home',XDG_CONFIG_HOME:fleet.root+'/config',XDG_STATE_HOME:fleet.root+'/state',XDG_CACHE_HOME:fleet.root+'/cache',TMUX_IDE_TESTDRIVE_RUNTIME_DIR:fleet.root+'/tui',TMUX_IDE_TESTDRIVE_HOST_SESSION:'nr04-paste-host-'+process.pid,TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH:fleet.root+'/host.sock',TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON:'1',TMUX_IDE_TESTDRIVE_CANONICAL_HOME:fleet.daemonInfoDir,TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR:fleet.daemonInfoDir};
const tmux=(...args)=>execFileSync(tmuxBin,['-S',fleet.socketPath,...args],{env,encoding:'utf8',timeout:5000}).trimEnd();
const drive=(...args)=>execFileSync(process.execPath,[repo+'/scripts/tui-testdrive.mjs',...args],{env,cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const expected=Buffer.from('rabc');writeFileSync(out+'/expected.bin',expected);
const actualPath=fleet.root+'/actual.bin',receiver=fleet.root+'/receiver.cjs';
const receiverSource=`const fs=require('node:fs');const path=${JSON.stringify(actualPath)};fs.writeFileSync(path,Buffer.alloc(0),{flag:'wx',mode:0o600});setTimeout(()=>process.exit(3),60000).unref();process.stdin.setRawMode(true);process.stdin.resume();let n=0;process.stdin.on('data',chunk=>{fs.appendFileSync(path,chunk);for(const byte of chunk){if(n===0&&byte===114){process.stdout.write('\\x1b[2J\\x1b[3;5HNR04_MAIN_SCREEN\\x1b[5;9H');continue;}if(byte!=='abc'.charCodeAt(n++))process.exit(2);if(n===1)process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[3;5HNR04_ALT_SCREEN\\x1b[8;13H');if(n===2)process.stdout.write('\\x1b[?1049l');if(n===3)process.stdout.write('\\x1b[12;1HNR04_ALT_FRESH_INPUT\\r\\n');}});process.stdout.write('\\x1b[2J\\x1b[3;5HNR04_MAIN_SCREEN\\x1b[5;9H');`;
writeFileSync(receiver,receiverSource);writeFileSync(out+'/receiver.cjs',receiverSource);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const wrapper=fleet.root+'/installed-tui.sh';
const wrapperText='#!/bin/sh\nexport TMUX_IDE_CLI='+quote(cli)+'\nexec '+quote(compiledTui)+' \"$@\"\n';
writeFileSync(wrapper,wrapperText,{mode:0o700});writeFileSync(out+'/runtime-wrapper.sh',wrapperText);env.TMUX_IDE_TESTDRIVE_TUI_BIN=wrapper;
let daemon,helper,latest,buffer='',stderr='',fatal,closing=false,tuiStarted=false;
const pids=new Set();const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const wait=async(test,label)=>{const until=Date.now()+30000;while(!test()){if(fatal)throw fatal;assert.ok(Date.now()<until,label+' deadline');await delay(25);}};
const source=()=>tmux('capture-pane','-p','-t',fleet.initialPanes[0].paneId);
const geometry=()=>tmux('display-message','-p','-t',fleet.initialPanes[0].paneId,'#{pane_id}|#{pane_pid}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}');
const grid=()=>latest?.snapshot?.grid.map(row=>row.cells.map(c=>c.grapheme).join('')).join('\n')??'';
const send=value=>helper.stdin.write(JSON.stringify(value)+'\n');
const result={lane,runtime:lane==='plain'?'plain stock tmux':lane==='tui'?'explicit compiled TUI plus installed npm daemon; not public installer qualification':'source GPUI bridge plus installed npm daemon; no physical GUI',installedCli:cli,compiledTui,compiledTuiSha256:compiledTuiHash,sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),cliSha256:hash(cli),tmuxSha256:hash(tmuxBin),tmuxVersion:execFileSync(tmuxBin,['-V'],{encoding:'utf8'}).trim(),node:process.version,expectedBytes:expected.length,expectedSha256:createHash('sha256').update(expected).digest('hex'),claim:'Alternate screen transition correctness; compiledTUI/sourceGPUIbridge distinct; no physical GPUI or performance claim'};
try{
 tmux('respawn-pane','-k','-t',fleet.initialPanes[0].paneId,'exec '+quote(process.execPath)+' '+quote(receiver));
 pids.add(Number(tmux('display-message','-p','#{pid}')));pids.add(Number(geometry().split('|')[1]));
 await wait(()=>source().includes('NR04_MAIN_SCREEN'),'receiver ready');
 if(lane==='plain'){
  tmux('set-option','-t',fleet.sessionNames[0],'status','off');tmux('set-window-option','-t',fleet.sessionNames[0],'window-size','manual');tmux('set-window-option','-t',fleet.sessionNames[0],'pane-border-status','top');tmux('resize-window','-t',fleet.sessionNames[0],'-x','132','-y','41');
 }else{
  daemon=await startDaemon({...fleet,environment:{...fleet.environment,HOME:env.HOME,XDG_CONFIG_HOME:env.XDG_CONFIG_HOME,XDG_STATE_HOME:env.XDG_STATE_HOME,XDG_CACHE_HOME:env.XDG_CACHE_HOME}},{cliPath:cli});pids.add(daemon.record.pid);
  if(lane==='tui'){
   tuiStarted=true;result.launch=drive('start','--target',fleet.sessionNames[0],'--cols','160','--rows','44');assert.ok(result.launch.includes('(compiled,'));
   const launcher=readFileSync(fleet.root+'/tui/launch.sh','utf8');writeFileSync(out+'/testdrive-launcher.sh',launcher);
   for(const value of execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'list-panes','-a','-F','#{pane_pid}'],{env,encoding:'utf8'}).trim().split('\n'))pids.add(Number(value));
   pids.add(Number(execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'display-message','-p','#{pid}'],{env,encoding:'utf8'}).trim()));
   await wait(()=>drive('capture').includes('NR04_MAIN_SCREEN'),'TUI receiver frame');
  }else{
   helper=spawn(process.execPath,['--import','tsx',repo+'/apps/tmux-gpui/bridge/browser.ts','--local'],{env,cwd:repo,stdio:['pipe','pipe','pipe']});pids.add(helper.pid);
   helper.on('error',()=>fatal=Error('helper spawn'));helper.on('exit',()=>{if(!closing)fatal=Error('helper exit');});for(const stream of [helper.stdin,helper.stdout,helper.stderr])stream.on('error',()=>{if(!closing)fatal=Error('helper stream');});
   helper.stderr.on('data',data=>stderr=(stderr+data).slice(-8192));helper.stdout.on('data',data=>{try{buffer+=data;assert.ok(Buffer.byteLength(buffer)<8*1024*1024);let end;while((end=buffer.indexOf('\n'))>=0){latest=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);}}catch{fatal=Error('publication');}});
   send({type:'presence',active:true,revision:1});await wait(()=>latest?.home?.phase==='live'&&latest.sessions.length===1,'Home');send({type:'session',request:1,id:latest.sessions[0].id});await wait(()=>latest?.request===1&&latest.sessionCatalogComplete&&latest.preferredPane,'catalog');send({type:'pane',request:2,id:latest.preferredPane});await wait(()=>latest?.inputReady&&latest.snapshot,'selected');send({type:'input',request:2,id:latest.selectedPane,input:{kind:'resize',data:{cols:132,rows:41}}});
   await wait(()=>latest?.inputReady&&latest.snapshot?.cols===132&&latest.snapshot?.rows===41&&latest.snapshot?.modes.alternateScreen===false&&grid().includes('NR04_MAIN_SCREEN'),'published bracketed mode');
  }
 }
 result.before=geometry();assert.equal(result.before.split('|').slice(2).join('|'),'0|1|132|40|132|41');
 const state=()=>{const [alternate,x,y,history,cursorVisible,savedX,savedY]=tmux('display-message','-p','-t',fleet.initialPanes[0].paneId,'#{alternate_on}|#{cursor_x}|#{cursor_y}|#{history_size}|#{cursor_flag}|#{alternate_saved_x}|#{alternate_saved_y}').trim().split('|').map(Number);return {alternate,x,y,history,cursorVisible,savedX,savedY};};
 const frame=()=>lane==='tui'?drive('capture'):lane==='gpui'?grid():source();
 const stage=async(name,marker,alternate,x,y)=>{
  await wait(()=>{const s=state();return s.alternate===alternate&&s.x===x&&s.y===y&&source().includes(marker);},name+' source state');
  await wait(()=>frame().includes(marker),name+' frame');
  if(lane==='gpui')await wait(()=>latest.snapshot?.modes.alternateScreen===Boolean(alternate)&&latest.snapshot.cursor.x===x&&latest.snapshot.cursor.y===y+1,name+' published mode and cursor');
  const capture=source();writeFileSync(out+'/'+name+'-source.txt',capture);writeFileSync(out+'/'+name+'-frame.txt',frame());result[name]={...state(),geometry:geometry(),...(lane==='gpui'?{publishedMode:latest.snapshot.modes.alternateScreen,publishedCursor:latest.snapshot.cursor}:{})};assert.equal(geometry(),result.before);return capture;
 };
 const input=character=>{if(lane==='plain')tmux('send-keys','-t',fleet.initialPanes[0].paneId,'-l',character);else if(lane==='tui')drive('text',character);else send({type:'input',request:2,id:latest.selectedPane,input:{kind:'text',data:character}});};
 input('r');
 const initial=await stage('initial','NR04_MAIN_SCREEN',0,8,4);
 input('a');const alternate=await stage('alternate','NR04_ALT_SCREEN',1,12,7);assert.ok(!alternate.includes('NR04_MAIN_SCREEN'));
 const saved=tmux('capture-pane','-a','-p','-t',fleet.initialPanes[0].paneId);writeFileSync(out+'/saved-main-source.txt',saved);assert.equal(saved,initial);assert.equal(result.alternate.history,result.initial.history);result.savedMainExact=true;
 input('b');const restored=await stage('restored','NR04_MAIN_SCREEN',0,8,4);assert.equal(restored,initial);assert.ok(!restored.includes('NR04_ALT_SCREEN'));result.exactMainRestoration=true;assert.equal(result.restored.history,result.initial.history);assert.equal(result.restored.cursorVisible,result.initial.cursorVisible);
 input('c');await wait(()=>source().includes('NR04_ALT_FRESH_INPUT')&&frame().includes('NR04_ALT_FRESH_INPUT'),'fresh input marker');
 writeFileSync(out+'/fresh-frame.txt',frame());writeFileSync(out+'/fresh-source.txt',source());assert.deepEqual(readFileSync(actualPath),expected);writeFileSync(out+'/actual.bin',readFileSync(actualPath));
 result.after=geometry();assert.equal(result.after,result.before);result.exactBytes=true;result.finalMarker=true;result.identityGeometryPreserved=true;result.pass=true;
}catch(error){result.pass=false;result.error=String(error);if(existsSync(actualPath))writeFileSync(out+'/actual.bin',readFileSync(actualPath));try{writeFileSync(out+'/failure.txt',lane==='tui'?drive('capture'):lane==='gpui'?grid():source());}catch{}}
finally{
 closing=true;result.cleanupErrors=[];
 for(const [label,stop] of [['helper',()=>helper&&stopFixtureChild(helper)],['tui',()=>tuiStarted&&drive('stop')],['daemon',()=>daemon&&daemon.stop()],['fleet',()=>fleet.dispose()]])try{await stop();}catch{result.cleanupErrors.push(label);}
 if(tuiStarted)try{execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'kill-server'],{env,stdio:'pipe',timeout:5000});}catch(e){if(!/no server running|No such file or directory/.test(String(e.stderr)))result.cleanupErrors.push('host');}
 for(let i=0;i<60&&[...pids].some(alive);i++)await delay(50);result.remainingOwnedPids=[...pids].filter(alive);result.ownedPidCount=pids.size;result.cleanup=result.cleanupErrors.length===0&&result.remainingOwnedPids.length===0;result.artifactsUnchanged=hash(cli)===cliHash&&hash(compiledTui)===compiledTuiHash;result.protectedCliUnchanged=hash(repo+'/bin/cli.js')===protectedHash;result.pass=Boolean(result.pass&&result.cleanup&&result.protectedCliUnchanged&&result.artifactsUnchanged);writeFileSync(out+'/stderr.txt',stderr);writeFileSync(out+'/receipt.json',JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
