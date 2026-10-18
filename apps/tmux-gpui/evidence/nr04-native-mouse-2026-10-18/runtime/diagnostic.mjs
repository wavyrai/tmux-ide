import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,statSync,accessSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const repo=process.cwd(),lane=process.argv[2];assert.ok(['gpui'].includes(lane));
const cliArgument=repo+'/.tasks/native-reliability-mission/installer-lifecycle/private-w5f4o2hz/installed/lib/node_modules/tmux-ide/bin/cli.js',tuiArgument=repo+'/.tasks/native-reliability-mission/packaged-paste/package-297-8yx0htjo/source/packages/daemon/dist/tui/tmux-ide-tui';
assert.ok(cliArgument?.startsWith('/')&&tuiArgument?.startsWith('/'),'Explicit absolute CLI and compiled TUI paths required');
const cli=realpathSync(cliArgument),compiledTui=realpathSync(tuiArgument);
assert.ok(statSync(cli).isFile()&&statSync(compiledTui).isFile());accessSync(compiledTui,constants.X_OK);
assert.ok(cli.endsWith('/bin/cli.js'));const packageRoot=cli.slice(0,-'/bin/cli.js'.length);
const packageMetadata=JSON.parse(readFileSync(packageRoot+'/package.json','utf8'));assert.equal(packageMetadata.name,'tmux-ide');assert.equal(packageMetadata.version,'2.9.7');
assert.match(process.argv[3]??'attempt-1',/^[a-z0-9-]+$/);
const out=repo+'/.tasks/native-reliability-mission/nr04-mouse-implementation/runtime/'+(process.argv[3]??'attempt-1');mkdirSync(out);
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
const mouseBytes='\x1b[<0;11;7M\x1b[<0;11;7m';const expected=Buffer.from(mouseBytes+'df');writeFileSync(out+'/expected.bin',expected);
const actualPath=fleet.root+'/actual.bin',receiver=fleet.root+'/receiver.cjs';
const receiverSource=`const fs=require('node:fs');const path=${JSON.stringify(actualPath)},mouse=${JSON.stringify(mouseBytes)};fs.writeFileSync(path,Buffer.alloc(0),{flag:'wx',mode:0o600});setTimeout(()=>process.exit(3),60000).unref();process.stdin.setRawMode(true);process.stdin.resume();let all='';process.stdin.on('data',chunk=>{fs.appendFileSync(path,chunk);all+=chunk.toString();if(all.length>256)process.exit(2);if(all===mouse)process.stdout.write('\\x1b[5;1HNR04_MOUSE_RECEIVED');if(all===mouse+'d')process.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[7;1HNR04_MOUSE_DISABLED');if(all===mouse+'df')process.stdout.write('\\x1b[9;1HNR04_MOUSE_FRESH');});process.stdout.write('\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[HNR04_MOUSE_READY');`;
writeFileSync(receiver,receiverSource);writeFileSync(out+'/receiver.cjs',receiverSource);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const wrapper=fleet.root+'/installed-tui.sh';
const wrapperText='#!/bin/sh\nexport TMUX_IDE_CLI='+quote(cli)+'\nexec '+quote(compiledTui)+' \"$@\"\n';
writeFileSync(wrapper,wrapperText,{mode:0o700});writeFileSync(out+'/runtime-wrapper.sh',wrapperText);env.TMUX_IDE_TESTDRIVE_TUI_BIN=wrapper;
let plainClient,daemon,helper,latest,buffer='',stderr='',fatal,closing=false,tuiStarted=false;
const pids=new Set();const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const wait=async(test,label)=>{const until=Date.now()+30000;while(!test()){if(fatal)throw fatal;assert.ok(Date.now()<until,label+' deadline');await delay(25);}};
const source=()=>tmux('capture-pane','-p','-t',fleet.initialPanes[0].paneId);
const geometry=()=>tmux('display-message','-p','-t',fleet.initialPanes[0].paneId,'#{pane_id}|#{pane_pid}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}');
const grid=()=>latest?.snapshot?.grid.map(row=>row.cells.map(c=>c.grapheme).join('')).join('\n')??'';
const send=value=>helper.stdin.write(JSON.stringify(value)+'\n');
const result={lane,runtime:lane==='plain'?'plain stock tmux':lane==='tui'?'explicit compiled TUI plus installed npm daemon; not public installer qualification':'source GPUI bridge plus installed npm daemon; no physical GUI',installedCli:cli,compiledTui,compiledTuiSha256:compiledTuiHash,sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),cliSha256:hash(cli),tmuxSha256:hash(tmuxBin),tmuxVersion:execFileSync(tmuxBin,['-V'],{encoding:'utf8'}).trim(),node:process.version,expectedBytes:expected.length,expectedSha256:createHash('sha256').update(expected).digest('hex'),claim:'GPUI semantic mouse bridge runtime; no nativeGUI claim'};
try{
 tmux('respawn-pane','-k','-t',fleet.initialPanes[0].paneId,'exec '+quote(process.execPath)+' '+quote(receiver));
 pids.add(Number(tmux('display-message','-p','#{pid}')));pids.add(Number(geometry().split('|')[1]));
 await wait(()=>source().includes('NR04_MOUSE_READY'),'receiver ready');
 if(lane==='plain'){
  tmux('set-option','-t',fleet.sessionNames[0],'status','off');tmux('set-window-option','-t',fleet.sessionNames[0],'window-size','manual');tmux('set-window-option','-t',fleet.sessionNames[0],'pane-border-status','top');tmux('resize-window','-t',fleet.sessionNames[0],'-x','132','-y','41');
 }else{
  daemon=await startDaemon({...fleet,environment:{...fleet.environment,HOME:env.HOME,XDG_CONFIG_HOME:env.XDG_CONFIG_HOME,XDG_STATE_HOME:env.XDG_STATE_HOME,XDG_CACHE_HOME:env.XDG_CACHE_HOME}},{cliPath:cli});pids.add(daemon.record.pid);
  if(lane==='tui'){
   tuiStarted=true;result.launch=drive('start','--target',fleet.sessionNames[0],'--cols','160','--rows','44');assert.ok(result.launch.includes('(compiled,'));
   const launcher=readFileSync(fleet.root+'/tui/launch.sh','utf8');writeFileSync(out+'/testdrive-launcher.sh',launcher);
   for(const value of execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'list-panes','-a','-F','#{pane_pid}'],{env,encoding:'utf8'}).trim().split('\n'))pids.add(Number(value));
   pids.add(Number(execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'display-message','-p','#{pid}'],{env,encoding:'utf8'}).trim()));
   await wait(()=>drive('capture').includes('NR04_MOUSE_READY'),'TUI receiver frame');
  }else{
   helper=spawn(process.execPath,['--import','tsx',repo+'/apps/tmux-gpui/bridge/browser.ts','--local'],{env,cwd:repo,stdio:['pipe','pipe','pipe']});pids.add(helper.pid);
   helper.on('error',()=>fatal=Error('helper spawn'));helper.on('exit',()=>{if(!closing)fatal=Error('helper exit');});for(const stream of [helper.stdin,helper.stdout,helper.stderr])stream.on('error',()=>{if(!closing)fatal=Error('helper stream');});
   helper.stderr.on('data',data=>stderr=(stderr+data).slice(-8192));helper.stdout.on('data',data=>{try{buffer+=data;assert.ok(Buffer.byteLength(buffer)<8*1024*1024);let end;while((end=buffer.indexOf('\n'))>=0){latest=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);}}catch{fatal=Error('publication');}});
   send({type:'presence',active:true,revision:1});await wait(()=>latest?.home?.phase==='live'&&latest.sessions.length===1,'Home');send({type:'session',request:1,id:latest.sessions[0].id});await wait(()=>latest?.request===1&&latest.sessionCatalogComplete&&latest.preferredPane,'catalog');send({type:'pane',request:2,id:latest.preferredPane});await wait(()=>latest?.inputReady&&latest.snapshot,'selected');send({type:'input',request:2,id:latest.selectedPane,input:{kind:'resize',data:{cols:132,rows:41}}});
   await wait(()=>latest?.inputReady&&latest.snapshot?.cols===132&&latest.snapshot?.rows===41&&latest.snapshot?.modes.alternateScreen===false&&grid().includes('NR04_MOUSE_READY'),'published bracketed mode');
  }
 }
 result.before=geometry();assert.equal(result.before.split('|').slice(2).join('|'),'0|1|132|40|132|41');
 const frame=()=>grid();
 const mouseFlag=()=>tmux('display-message','-p','-t',fleet.initialPanes[0].paneId,'#{mouse_standard_flag}|#{mouse_sgr_flag}').trim();
 await wait(()=>mouseFlag()==='1|1','source mouse enabled');result.sourceEnabledFlags=mouseFlag();
 if(lane==='plain'){
  tmux('set-option','-g','mouse','on');
  const pty=createRequire(cli)('node-pty');plainClient=pty.spawn(tmuxBin,['-S',fleet.socketPath,'attach-session','-t',fleet.sessionNames[0]],{name:'xterm-256color',cols:132,rows:41,cwd:fleet.root,env:{...env,TERM:'xterm-256color'}});pids.add(plainClient.pid);
  let attached='';plainClient.onData(data=>attached=(attached+data).slice(-16384));await wait(()=>attached.includes('NR04_MOUSE_READY'),'plain attached frame');
 }
 const input=character=>send({type:'input',request:2,id:latest.selectedPane,input:{kind:'text',data:character}});
 let gesture=0;
 const mouse=(action,id=gesture,overrides={})=>{
  const region=latest.regions.find(r=>r.id===latest.selectedPane);assert.ok(region);
  send({type:'input',request:2,id:latest.selectedPane,input:{kind:'mouse',data:{action,gesture:id,row:6,col:10,button:0,shift:false,alt:false,control:false,protocol:'vt200',encoding:'sgr',cols:region.width,rows:region.height,...overrides}}});
 };
 result.publishedModeProof={modes:latest.snapshot.modes,selectedRegion:latest.regions.find(r=>r.id===latest.selectedPane),snapshotCols:latest.snapshot.cols,snapshotRows:latest.snapshot.rows};
 assert.equal(latest.snapshot.modes.mouseProtocol,'vt200','Expected initial reporting protocol');assert.equal(latest.snapshot.modes.mouseEncoding,'sgr','Expected initial reporting encoding');
 const click=()=>{gesture++;mouse('down');mouse('up');};
 click();await wait(()=>existsSync(actualPath)&&readFileSync(actualPath).length>=Buffer.byteLength(mouseBytes),'mouse bytes');assert.deepEqual(readFileSync(actualPath),Buffer.from(mouseBytes));
 await wait(()=>source().includes('NR04_MOUSE_RECEIVED')&&frame().includes('NR04_MOUSE_RECEIVED'),'mouse received marker');writeFileSync(out+'/enabled-source.txt',source());writeFileSync(out+'/enabled-frame.txt',frame());result.enabledExact=true;
 input('d');await wait(()=>mouseFlag()==='0|0'&&source().includes('NR04_MOUSE_DISABLED')&&frame().includes('NR04_MOUSE_DISABLED'),'disabled state');result.disabledFlags=mouseFlag();
 click();input('f');await wait(()=>source().includes('NR04_MOUSE_FRESH')&&frame().includes('NR04_MOUSE_FRESH'),'fresh after disabled click');assert.deepEqual(readFileSync(actualPath),expected);writeFileSync(out+'/actual.bin',readFileSync(actualPath));writeFileSync(out+'/fresh-frame.txt',frame());writeFileSync(out+'/fresh-source.txt',source());
 result.after=geometry();assert.equal(result.after,result.before);result.exactBytes=true;result.disabledNoLeak=true;result.finalMarker=true;result.identityGeometryPreserved=true;result.pass=true;
}catch(error){result.pass=false;result.error=String(error);if(existsSync(actualPath))writeFileSync(out+'/actual.bin',readFileSync(actualPath));try{writeFileSync(out+'/failure.txt',lane==='tui'?drive('capture'):lane==='gpui'?grid():source());}catch{}}
finally{
 closing=true;result.cleanupErrors=[];
 for(const [label,stop] of [['plain-client',()=>plainClient&&plainClient.kill()],['helper',()=>helper&&stopFixtureChild(helper)],['tui',()=>tuiStarted&&drive('stop')],['daemon',()=>daemon&&daemon.stop()],['fleet',()=>fleet.dispose()]])try{await stop();}catch{result.cleanupErrors.push(label);}
 if(tuiStarted)try{execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'kill-server'],{env,stdio:'pipe',timeout:5000});}catch(e){if(!/no server running|No such file or directory/.test(String(e.stderr)))result.cleanupErrors.push('host');}
 for(let i=0;i<60&&[...pids].some(alive);i++)await delay(50);result.remainingOwnedPids=[...pids].filter(alive);result.ownedPidCount=pids.size;result.cleanup=result.cleanupErrors.length===0&&result.remainingOwnedPids.length===0;result.artifactsUnchanged=hash(cli)===cliHash&&hash(compiledTui)===compiledTuiHash;result.protectedCliUnchanged=hash(repo+'/bin/cli.js')===protectedHash;result.pass=Boolean(result.pass&&result.cleanup&&result.protectedCliUnchanged&&result.artifactsUnchanged);writeFileSync(out+'/stderr.txt',stderr);writeFileSync(out+'/receipt.json',JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
