import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const repo=process.cwd(),lane=process.argv[2];assert.ok(['plain','tui','gpui'].includes(lane));
const modeOn=process.argv[3]!=='off';
const out=repo+'/.tasks/native-reliability-mission/nr04-unicode-paste/'+lane+(modeOn?'':'-off');mkdirSync(out);
const tmuxBin=repo+'/.tasks/tmux38-compat/tmux-3.8/tmux';
const cli=repo+'/.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const protectedHash=hash(repo+'/bin/cli.js');
for(const key of Object.keys(process.env))if(key.startsWith('TMUX')||['NODE_OPTIONS','NODE_PATH'].includes(key))delete process.env[key];
process.env.PATH=repo+'/.tasks/tmux38-compat/tmux-3.8:/private/tmp/tmux-ide-295-release-nkydyctm/tools:'+process.env.PATH;
const {createScratchFleet}=await import(repo+'/scripts/lib/product-fixtures/scratch-fleet.ts');
const {startDaemon}=await import(repo+'/scripts/lib/product-fixtures/daemon.ts');
const {stopFixtureChild}=await import(repo+'/apps/tmux-gpui/bridge/fixture-child.mjs');
const fleet=await createScratchFleet({sessions:1,windowsPerSession:1,slug:'nr04-paste-'+lane});
const env={...process.env,...fleet.environment,TMUX_IDE_TMUX_SOCKET_PATH:fleet.socketPath,HOME:fleet.root+'/home',XDG_CONFIG_HOME:fleet.root+'/config',XDG_STATE_HOME:fleet.root+'/state',XDG_CACHE_HOME:fleet.root+'/cache',TMUX_IDE_TESTDRIVE_RUNTIME_DIR:fleet.root+'/tui',TMUX_IDE_TESTDRIVE_HOST_SESSION:'nr04-paste-host-'+process.pid,TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH:fleet.root+'/host.sock',TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON:'1',TMUX_IDE_TESTDRIVE_CANONICAL_HOME:fleet.daemonInfoDir,TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR:fleet.daemonInfoDir};
const tmux=(...args)=>execFileSync(tmuxBin,['-S',fleet.socketPath,...args],{env,encoding:'utf8',timeout:5000}).trimEnd();
const drive=(...args)=>execFileSync(process.execPath,[repo+'/scripts/tui-testdrive.mjs',...args],{env,cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const intro='界🌍 e\u0301 é\n';
const payload=intro+'x'.repeat(1017-intro.length)+'🌍'+'y'.repeat(1050)+'界e\u0301\n$(NEVER_EXECUTE); literal \"quotes\"\nUNICODE_PAYLOAD_END';
const expected=Buffer.from(modeOn?'\x1b[200~'+payload+'\x1b[201~':payload);
writeFileSync(out+'/payload.txt',payload);writeFileSync(out+'/expected.bin',expected);
const actualPath=fleet.root+'/actual.bin',receiver=fleet.root+'/receiver.cjs';
writeFileSync(receiver,`const fs=require('node:fs');const expected=Buffer.from(${JSON.stringify(expected.toString('base64'))},'base64');const path=${JSON.stringify(actualPath)};fs.writeFileSync(path,Buffer.alloc(0),{flag:'wx',mode:0o600});setTimeout(()=>process.exit(3),60000).unref();process.stdin.setRawMode(true);process.stdin.resume();let all=Buffer.alloc(0);process.stdin.on('data',chunk=>{all=Buffer.concat([all,chunk]);if(all.length>8192)process.exit(2);fs.appendFileSync(path,chunk);if(all.length===expected.length){if(!all.equals(expected))process.stdout.write('\\r\\nNR04_BYTES_MISMATCH\\r\\n');else process.stdout.write('\\r\\nUNICODE_ECHO 界🌍 é é\\r\\nNR04_UNICODE_DONE\\r\\n');}});process.stdout.write('${modeOn?'\\x1b[?2004h':'\\x1b[?2004l'}\\x1b[2J\\x1b[HNR04_RECEIVER_READY\\r\\n');`);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
let daemon,helper,latest,buffer='',stderr='',fatal,closing=false,tuiStarted=false;
const pids=new Set();const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const wait=async(test,label)=>{const until=Date.now()+30000;while(!test()){if(fatal)throw fatal;assert.ok(Date.now()<until,label+' deadline');await delay(25);}};
const source=()=>tmux('capture-pane','-p','-t',fleet.initialPanes[0].paneId);
const geometry=()=>tmux('display-message','-p','-t',fleet.initialPanes[0].paneId,'#{pane_id}|#{pane_pid}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}');
const grid=()=>latest?.snapshot?.grid.map(row=>row.cells.map(c=>c.grapheme).join('')).join('\n')??'';
const send=value=>helper.stdin.write(JSON.stringify(value)+'\n');
const result={lane,modeOn,sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),cliSha256:hash(cli),tmuxSha256:hash(tmuxBin),tmuxVersion:execFileSync(tmuxBin,['-V'],{encoding:'utf8'}).trim(),node:process.version,payloadBytes:Buffer.byteLength(payload),payloadCodeUnits:payload.length,expectedBytes:expected.length,expectedSha256:createHash('sha256').update(expected).digest('hex'),claim:'DEC2004-'+(modeOn?'on':'off')+' byte fidelity and coherent content only; no physical GPUI or performance claim'};
try{
 tmux('respawn-pane','-k','-t',fleet.initialPanes[0].paneId,'exec '+quote(process.execPath)+' '+quote(receiver));
 pids.add(Number(tmux('display-message','-p','#{pid}')));pids.add(Number(geometry().split('|')[1]));
 await wait(()=>source().includes('NR04_RECEIVER_READY')&&tmux('display-message','-p','-t',fleet.initialPanes[0].paneId,'#{bracket_paste_flag}').trim()===(modeOn?'1':'0'),'receiver DEC2004 ready');
 if(lane==='plain'){
  tmux('set-option','-t',fleet.sessionNames[0],'status','off');tmux('set-window-option','-t',fleet.sessionNames[0],'window-size','manual');tmux('set-window-option','-t',fleet.sessionNames[0],'pane-border-status','top');tmux('resize-window','-t',fleet.sessionNames[0],'-x','132','-y','41');
 }else{
  daemon=await startDaemon({...fleet,environment:{...fleet.environment,HOME:env.HOME,XDG_CONFIG_HOME:env.XDG_CONFIG_HOME,XDG_STATE_HOME:env.XDG_STATE_HOME,XDG_CACHE_HOME:env.XDG_CACHE_HOME}},{cliPath:cli});pids.add(daemon.record.pid);
  if(lane==='tui'){
   tuiStarted=true;drive('start','--source','--target',fleet.sessionNames[0],'--cols','160','--rows','44');
   for(const value of execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'list-panes','-a','-F','#{pane_pid}'],{env,encoding:'utf8'}).trim().split('\n'))pids.add(Number(value));
   pids.add(Number(execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'display-message','-p','#{pid}'],{env,encoding:'utf8'}).trim()));
   await wait(()=>drive('capture').includes('NR04_RECEIVER_READY'),'TUI receiver frame');
  }else{
   helper=spawn(process.execPath,['--import','tsx',repo+'/apps/tmux-gpui/bridge/browser.ts','--local'],{env,cwd:repo,stdio:['pipe','pipe','pipe']});pids.add(helper.pid);
   helper.on('error',()=>fatal=Error('helper spawn'));helper.on('exit',()=>{if(!closing)fatal=Error('helper exit');});for(const stream of [helper.stdin,helper.stdout,helper.stderr])stream.on('error',()=>{if(!closing)fatal=Error('helper stream');});
   helper.stderr.on('data',data=>stderr=(stderr+data).slice(-8192));helper.stdout.on('data',data=>{try{buffer+=data;assert.ok(Buffer.byteLength(buffer)<8*1024*1024);let end;while((end=buffer.indexOf('\n'))>=0){latest=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);}}catch{fatal=Error('publication');}});
   send({type:'presence',active:true,revision:1});await wait(()=>latest?.home?.phase==='live'&&latest.sessions.length===1,'Home');send({type:'session',request:1,id:latest.sessions[0].id});await wait(()=>latest?.request===1&&latest.sessionCatalogComplete&&latest.preferredPane,'catalog');send({type:'pane',request:2,id:latest.preferredPane});await wait(()=>latest?.inputReady&&latest.snapshot,'selected');send({type:'input',request:2,id:latest.selectedPane,input:{kind:'resize',data:{cols:132,rows:41}}});
   await wait(()=>latest?.inputReady&&latest.snapshot?.cols===132&&latest.snapshot?.rows===41&&latest.snapshot?.modes.bracketedPaste===modeOn&&grid().includes('NR04_RECEIVER_READY'),'published bracketed mode');result.publishedBracketedPaste=latest.snapshot.modes.bracketedPaste;
  }
 }
 result.before=geometry();assert.equal(result.before.split('|').slice(2).join('|'),'0|1|132|40|132|41');
 assert.equal(tmux('display-message','-p','-t',fleet.initialPanes[0].paneId,'#{bracket_paste_flag}').trim(),modeOn?'1':'0');result.sourceBracketedPaste=modeOn;
 if(lane==='plain'){tmux('load-buffer','-b','nr04-owned-paste',out+'/payload.txt');tmux('paste-buffer','-d','-p','-r','-b','nr04-owned-paste','-t',fleet.initialPanes[0].paneId);}
 else if(lane==='tui')result.inputReceipt=JSON.parse(drive('input',JSON.stringify({version:1,kind:'paste',text:payload})));
 else send({type:'input',request:2,id:latest.selectedPane,input:{kind:'paste',data:payload}});
 await wait(()=>existsSync(actualPath)&&readFileSync(actualPath).length>=expected.length,'receiver bytes');const actual=readFileSync(actualPath);writeFileSync(out+'/actual.bin',actual);assert.deepEqual(actual,expected);
 await wait(()=>source().includes('NR04_UNICODE_DONE'),'source marker');let frame;
 if(lane==='tui'){await wait(()=>drive('capture').includes('NR04_UNICODE_DONE'),'TUI final marker');frame=drive('capture');}
 else if(lane==='gpui'){await wait(()=>grid().includes('NR04_UNICODE_DONE'),'published final marker');frame=grid();}else frame=source();
 assert.ok(frame.includes('界🌍'));writeFileSync(out+'/frame.txt',frame);writeFileSync(out+'/source.txt',source());
 result.after=geometry();assert.equal(result.after,result.before);assert.deepEqual(readFileSync(actualPath),expected,'Final receiver bytes after published marker and geometry');writeFileSync(out+'/actual.bin',readFileSync(actualPath));result.finalBytesRechecked=true;result.exactBytes=true;result.finalMarker=true;result.identityGeometryPreserved=true;result.pass=true;
}catch(error){result.pass=false;result.error=String(error);if(existsSync(actualPath))writeFileSync(out+'/actual.bin',readFileSync(actualPath));try{writeFileSync(out+'/failure.txt',lane==='tui'?drive('capture'):lane==='gpui'?grid():source());}catch{}}
finally{
 closing=true;result.cleanupErrors=[];
 for(const [label,stop] of [['helper',()=>helper&&stopFixtureChild(helper)],['tui',()=>tuiStarted&&drive('stop')],['daemon',()=>daemon&&daemon.stop()],['fleet',()=>fleet.dispose()]])try{await stop();}catch{result.cleanupErrors.push(label);}
 if(tuiStarted)try{execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'kill-server'],{env,stdio:'pipe',timeout:5000});}catch(e){if(!/no server running|No such file or directory/.test(String(e.stderr)))result.cleanupErrors.push('host');}
 for(let i=0;i<60&&[...pids].some(alive);i++)await delay(50);result.remainingOwnedPids=[...pids].filter(alive);result.ownedPidCount=pids.size;result.cleanup=result.cleanupErrors.length===0&&result.remainingOwnedPids.length===0;result.protectedCliUnchanged=hash(repo+'/bin/cli.js')===protectedHash;result.pass=Boolean(result.pass&&result.cleanup&&result.protectedCliUnchanged);writeFileSync(out+'/stderr.txt',stderr);writeFileSync(out+'/receipt.json',JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
