// Private actual-TUI opener observation; never launches a URL or browser.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const repo=process.cwd(),lane=process.argv[2];assert.ok(['plain','tui'].includes(lane));
const suffix=process.argv[3]??lane;assert.ok([lane,lane+'-final'].includes(suffix));const out=repo+'/.tasks/native-reliability-mission/nr04-links-fixture/'+suffix;mkdirSync(out);
const cli=realpathSync(repo+'/.tasks/native-reliability-mission/installer-lifecycle/private-w5f4o2hz/installed/lib/node_modules/tmux-ide/bin/cli.js');
const archive=repo+'/.tasks/native-reliability-mission/packaged-paste/package-297-8yx0htjo/source';
const tui=archive+'/packages/daemon/dist/tui/tmux-ide-tui',tmuxBin=repo+'/.tasks/tmux38-compat/tmux-3.8/tmux';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const paths=[cli,tui,tmuxBin,repo+'/bin/cli.js',repo+'/scripts/tui-testdrive.mjs',archive+'/packages/daemon/src/tui/mirror/runtime/terminal-links.ts',archive+'/packages/daemon/src/tui/mirror/runtime/terminal-link-opener.ts'];
const hashes=Object.fromEntries(paths.map(p=>[p,hash(p)]));
assert.equal(hashes[tui],'0204da65810321f673ae3ed1038e59d2a8d1eebe90b90d17b87a20540f17c1f2');
assert.equal(hashes[cli],'9f6c49a1155558be0689f8cea2bb433bbfc7c3eccf090827c3a3c0f0515c0366');
assert.equal(JSON.parse(readFileSync(cli.replace('/bin/cli.js','/package.json'))).version,'2.9.7');
assert.match(process.version,/^v24\./);assert.equal(execFileSync(tmuxBin,['-V'],{encoding:'utf8'}).trim(),'tmux 3.8');
// The audited compiled source uses the bare platform command, so this private PATH interposes it.
assert.ok(readFileSync(paths.at(-1),'utf8').includes('spawn(command, [url], { stdio: "ignore", shell: false })'));
for(const key of Object.keys(process.env))if(key.startsWith('TMUX')||['NODE_OPTIONS','NODE_PATH'].includes(key))delete process.env[key];
process.env.PATH=repo+'/.tasks/tmux38-compat/tmux-3.8:/private/tmp/tmux-ide-295-release-nkydyctm/tools:/usr/bin:/bin:/usr/sbin:/sbin';
const {createScratchFleet}=await import(repo+'/scripts/lib/product-fixtures/scratch-fleet.ts');
const {startDaemon}=await import(repo+'/scripts/lib/product-fixtures/daemon.ts');
const fleet=await createScratchFleet({sessions:1,windowsPerSession:1,slug:'nr04-links-'+lane});
const env={...process.env,...fleet.environment,HOME:fleet.root+'/home',TMUX_IDE_TMUX_SOCKET_PATH:fleet.socketPath,TMUX_IDE_TESTDRIVE_RUNTIME_DIR:fleet.root+'/tui',TMUX_IDE_TESTDRIVE_HOST_SESSION:'nr04-links-host-'+process.pid,TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH:fleet.root+'/host.sock',TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON:'1',TMUX_IDE_TESTDRIVE_CANONICAL_HOME:fleet.daemonInfoDir,TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR:fleet.daemonInfoDir};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const tmux=(...args)=>execFileSync(tmuxBin,['-S',fleet.socketPath,...args],{env,encoding:'utf8',timeout:5000}).trimEnd();
const drive=(...args)=>execFileSync(process.execPath,[repo+'/scripts/tui-testdrive.mjs',...args],{env,cwd:repo,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const pids=new Set(),alive=p=>{try{process.kill(p,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const tree=()=>{const rows=execFileSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(x=>x.trim().split(/\s+/).map(Number));let changed=true;while(changed){changed=false;for(const [p,parent]of rows)if(pids.has(parent)&&!pids.has(p)){pids.add(p);changed=true;}}};
const wait=async(f,label)=>{const end=Date.now()+30000;while(!f()){assert.ok(Date.now()<end,label+' deadline');await delay(25);}};
const urls=['https://example.invalid/a(b)','http://example.invalid/ok','https://example.invalid/'+ 'w'.repeat(58)];
const recorder=fleet.root+'/record.cjs',record=fleet.root+'/opened.jsonl',bin=fleet.root+'/bin';mkdirSync(bin);
writeFileSync(recorder,`const fs=require('node:fs');const args=process.argv.slice(2);if(args.length!==1||Buffer.byteLength(args[0])>8192)process.exit(2);fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(args)+'\\n',{mode:0o600});`);
for(const command of ['open','xdg-open'])writeFileSync(bin+'/'+command,'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(recorder)+' "$@"\n',{mode:0o700});
const wrapper=fleet.root+'/tui-wrapper.sh';writeFileSync(wrapper,'#!/bin/sh\nexport PATH='+quote(bin+':'+env.PATH)+'\nexport TMUX_IDE_CLI='+quote(cli)+'\nexec '+quote(tui)+' "$@"\n',{mode:0o700});env.TMUX_IDE_TESTDRIVE_TUI_BIN=wrapper;
const payload=(right)=>right?'\x1b[2J\x1b[HNR04_RIGHT\x1b[12;1Hexample.invalid/ adjacent': '\x1b[2J\x1b[HNR04_LEFT\x1b[2;1H'+urls[0]+'. done\x1b[3;1H'+urls[1]+' done\x1b[4;1H'+urls[2]+' done\x1b[8;1Hfile:///tmp/no-open\x1b[9;1Hjavascript:alert(1)\x1b[10;1Hmailto:a@example.invalid\x1b[11;1H\x1b]8;;https://hidden.invalid/\x1b\\FRIENDLY_LABEL\x1b]8;;\x1b\\\x1b[12;59Hhttps://';
let daemon,started=false,hostStarted=false,panes=[];
const readOpens=()=>existsSync(record)?readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const expectedOpens=urls.map(url=>[url]).concat([[urls[0]]]);const result={lane,hashes,compiledSourceCommit:JSON.parse(readFileSync(archive+'/../artifact-provenance.json')).sourceCommit,sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'plain source output reference; compiled TUI visible HTTP(S) activation through private recorder; no browser or native GUI',checks:[]};
try{
 tmux('set-option','-t',fleet.sessionNames[0]+':','status','off');tmux('set-window-option','-t',fleet.sessionNames[0]+':','window-size','manual');tmux('set-window-option','-t',fleet.sessionNames[0]+':','pane-border-status','top');tmux('resize-window','-t',fleet.sessionNames[0]+':','-x','132','-y','41');
 tmux('split-window','-h','-t',fleet.initialPanes[0].paneId);panes=tmux('list-panes','-t',fleet.sessionNames[0]+':','-F','#{pane_id}').split('\n');assert.equal(panes.length,2);
 for(let i=0;i<2;i++){
  const receiver=fleet.root+'/receiver-'+i+'.cjs',input=fleet.root+'/input-'+i+'.bin';
  writeFileSync(receiver,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(input)},'');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',d=>{fs.appendFileSync(${JSON.stringify(input)},d);if(d.toString()==='r')process.stdout.write(${JSON.stringify(payload(i===1))});});setTimeout(()=>process.exit(),120000);process.stdout.write(${JSON.stringify(payload(i===1))});`);
  tmux('respawn-pane','-k','-t',panes[i],'exec '+quote(process.execPath)+' '+quote(receiver));
 }
 pids.add(Number(tmux('display-message','-p','#{pid}')));for(const p of panes)pids.add(Number(tmux('display-message','-p','-t',p,'#{pane_pid}')));
 if(lane==='tui'){
  daemon=await startDaemon({...fleet,environment:{...fleet.environment,HOME:env.HOME}},{cliPath:cli});pids.add(daemon.record.pid);
  started=true;hostStarted=true;result.launch=drive('start','--target',fleet.sessionNames[0],'--cols','160','--rows','44');assert.ok(result.launch.includes('(compiled,'));
  const host=(...a)=>execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,...a],{env,encoding:'utf8'}).trim();
  pids.add(Number(host('display-message','-p','#{pid}')));for(const p of host('list-panes','-a','-F','#{pane_pid}').split('\n'))pids.add(Number(p));tree();
  await wait(()=>drive('capture').includes('NR04_LEFT')&&drive('capture').includes('NR04_RIGHT'),'two pane frame');
 }
 const geometry=()=>panes.map(p=>tmux('display-message','-p','-t',p,'#{pane_id}|#{pane_pid}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}'));
 result.before=geometry();assert.ok(result.before.every(x=>x.endsWith('|132|41')));assert.equal(result.before[0].split('|')[4],'66','fixed left-pane wrap width');
 for(let i=0;i<2;i++){writeFileSync(out+'/source-'+i+'.txt',tmux('capture-pane','-p','-t',panes[i]));writeFileSync(out+'/joined-'+i+'.txt',tmux('capture-pane','-J','-p','-t',panes[i]));}
 assert.ok(tmux('capture-pane','-J','-p','-t',panes[0]).includes(urls[2]));assert.ok(!tmux('capture-pane','-p','-t',panes[0]).includes('hidden.invalid'));
 if(lane==='tui'){
  const frame=drive('capture');writeFileSync(out+'/frame.txt',frame);const lines=frame.split('\n');const y=lines.findIndex(x=>x.includes('NR04_LEFT')),x=lines[y].indexOf('NR04_LEFT');assert.ok(x>=0&&y>=0);
  const records=()=>existsSync(record)?readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const click=(col,row)=>drive('input',JSON.stringify({version:1,kind:'application-mouse',action:'click',x:x+col,y:y+row,button:'left',modifiers:['ctrl']}));
  for(const [row,url]of [[1,urls[0]],[2,urls[1]],[4,urls[2]]]){const n=records().length;click(5,row);await wait(()=>records().length>n,'allowed URL recorder');assert.equal(records().length,n+1);assert.deepEqual(records().at(-1),[url]);result.checks.push({kind:'allow',row});}
  const n=records().length;for(const row of [7,8,9,10,11])click(row===11?61:5,row);
  // Ordered subsequent known-positive activation bounds the no-open observation window.
  click(5,1);await wait(()=>records().length>n,'negative batch barrier');assert.equal(records().length,n+1);assert.deepEqual(records().at(-1),[urls[0]]);
  result.checks.push({kind:'refuse',rows:[7,8,9,10,11],scope:'unsafe schemes, OSC8 friendly label, adjacent incomplete URL'});
  const observationStart=Date.now(); await delay(500); assert.deepEqual(records(),expectedOpens); result.negativeObservationMs=Date.now()-observationStart;
  result.after=geometry();assert.deepEqual(result.after,result.before);
  drive('stop'); started=false;
  await delay(250); assert.deepEqual(readOpens(),expectedOpens);
  for(let i=0;i<2;i++)assert.equal(readFileSync(fleet.root+'/input-'+i+'.bin').length,0,'post-TUI-stop application bytes');
  result.postTuiStopVerified=true;result.postStopObservationMs=250;
  writeFileSync(out+'/opened.json',JSON.stringify(readOpens(),null,2));
 }
 if(lane==='plain'){result.after=geometry();assert.deepEqual(result.after,result.before);}else{result.postStopGeometry=geometry();assert.deepEqual(result.postStopGeometry.map(x=>x.split('|').slice(0,2)),result.before.map(x=>x.split('|').slice(0,2)));}for(let i=0;i<2;i++)assert.equal(readFileSync(fleet.root+'/input-'+i+'.bin').length,0,'link click must not reach application');result.pass=true;
}catch(e){result.pass=false;result.error=String(e);}
finally{
 result.cleanupErrors=[];try{tree();}catch{result.cleanupErrors.push('process inventory');}
 for(const [name,stop]of [['tui',()=>started&&drive('stop')],['daemon',()=>daemon&&daemon.stop()],['fleet',()=>fleet.dispose()]])try{await stop();}catch{result.cleanupErrors.push(name);}
 if(hostStarted)try{execFileSync(tmuxBin,['-S',env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH,'kill-server'],{env,stdio:'pipe'});}catch(e){if(!/no server running|No such file or directory/.test(String(e.stderr)))result.cleanupErrors.push('host');}
 for(let i=0;i<160&&[...pids].some(alive);i++)await delay(50);result.remainingOwnedPids=[...pids].filter(alive);result.cleanup=result.cleanupErrors.length===0&&result.remainingOwnedPids.length===0;
 result.hashesUnchanged=paths.every(p=>hash(p)===hashes[p]);result.pass=!!(result.pass&&result.cleanup&&result.hashesUnchanged);writeFileSync(out+'/receipt.json',JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;
