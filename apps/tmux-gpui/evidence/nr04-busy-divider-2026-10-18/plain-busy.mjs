import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const repo=process.cwd(), output=repo+'/.tasks/native-reliability-mission/nr04-busy/plain-busy.json';
mkdirSync(repo+'/.tasks/native-reliability-mission/nr04-busy',{recursive:true});
const binary=repo+'/.tasks/tmux38-compat/tmux-3.8/tmux';
const root=mkdtempSync('/tmp/nr04-plain-'),socket=root+'/tmux.sock';
const env={...process.env,HOME:root,XDG_CONFIG_HOME:root,XDG_STATE_HOME:root,TMUX:'',TMUX_TMPDIR:''};
for(const key of Object.keys(env))if(key.startsWith('TMUX_IDE_'))delete env[key];
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const protectedHash=hash(repo+'/bin/cli.js');
const tmux=(...args)=>{assert.equal(socket,root+'/tmux.sock');assert.ok(root.startsWith('/tmp/nr04-plain-'));return execFileSync(binary,['-S',socket,...args],{env,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();};
const snapshot=()=>tmux('list-panes','-t','nr04:0','-F','#{pane_id}|#{pane_pid}|#{pane_birth_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}|#{window_zoomed_flag}').split('\n');
const identity=rows=>rows.map(row=>row.split('|').slice(0,2).join('|'));
const ownedPids=new Set();const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const receipt={lane:'plain-tmux',actionPath:'Direct resize-pane commands; moved/released labels are matched geometry stages, not pointer events',tmuxVersion:execFileSync(binary,['-V'],{encoding:'utf8'}).trim(),tmuxSha256:hash(binary),node:process.version};
try{
 tmux('-f','/dev/null','new-session','-d','-s','nr04','-x','132','-y','41',"printf 'RIG_NR04_LEFT_CONTENT\\n'; exec /bin/sh -i");
 tmux('set-option','-t','nr04','status','off');tmux('set-window-option','-t','nr04:0','window-size','manual');tmux('set-window-option','-t','nr04:0','pane-border-status','top');receipt.headerPolicy='Explicit pane-border-status top matches TUI-adopted source content geometry; plain default differs';
 tmux('resize-window','-t','nr04:0','-x','132','-y','41');
 tmux('split-window','-h','-d','-t','nr04:0',"printf 'RIG_NR04_RIGHT_CONTENT\\n'; exec /bin/sh -i");
 await delay(150);receipt.initial=snapshot();ownedPids.add(Number(tmux('display-message','-p','#{pid}')));for(const row of receipt.initial)ownedPids.add(Number(row.split('|')[1]));
 assert.deepEqual(receipt.initial.map(r=>r.split('|').slice(3,9)),[['0','1','66','40','132','41'],['67','1','65','40','132','41']]);
 const left=receipt.initial[0].split('|')[0];
 const producer=repo+'/.tasks/native-reliability-mission/nr04-busy/producer.sh';
 const script=root+'/busy.sh';writeFileSync(script,readFileSync(producer));receipt.producerSha256=hash(producer);
 const content=()=>tmux('capture-pane','-p','-t',left);
 const tick=()=>Number(content().match(/NR04_TICK_(\d+)/)?.[1]||0);
 const wait=async(fn)=>{for(let i=0;i<400;i++){if(fn())return;await delay(50);}throw Error('busy producer deadline');};
 tmux('send-keys','-t',left,'-l','sh '+script);tmux('send-keys','-t',left,'Enter');
 await wait(()=>tick()>0);receipt.busyStages=[];

 for(const [name,width] of [['moved',69],['released',75],['restored',66]]){
  const beforeTick=tick();assert.ok(beforeTick>0&&beforeTick<200);
  tmux('resize-pane','-t',left,'-x',String(width));receipt[name]=snapshot();
  await wait(()=>tick()>beforeTick);const afterTick=tick();assert.ok(afterTick<200&&!content().includes('NR04_BUSY_DONE'));receipt.busyStages.push({name,beforeTick,afterTick});
  assert.deepEqual(receipt[name].map(r=>r.split('|').slice(3,9)),[['0','1',String(width),'40','132','41'],[String(width+1),'1',String(131-width),'40','132','41']]);
  assert.deepEqual(identity(receipt[name]),identity(receipt.initial));
  assert.ok(receipt[name].every((r,i)=>tmux('capture-pane','-p','-t',r.split('|')[0]).split('\n').includes(i===0?'RIG_NR04_LEFT_CONTENT':'RIG_NR04_RIGHT_CONTENT')));
 }
 assert.deepEqual(receipt.restored,receipt.initial);
 await wait(()=>content().includes('NR04_BUSY_DONE'));receipt.finalTick=tick();assert.equal(receipt.finalTick,200);receipt.producerCompleted=true;
 receipt.contentPreserved=receipt.initial.every((r,i)=>tmux('capture-pane','-p','-t',r.split('|')[0]).split('\n').includes(i===0?'RIG_NR04_LEFT_CONTENT':'RIG_NR04_RIGHT_CONTENT'));
 assert.ok(receipt.contentPreserved);
 const pane=receipt.initial[0].split('|')[0];tmux('send-keys','-t',pane,'-l',"printf 'RIG_NR04_FRESH_INPUT\\n'");tmux('send-keys','-t',pane,'Enter');await delay(100);
 const capture=tmux('capture-pane','-p','-t',pane);writeFileSync(repo+'/.tasks/native-reliability-mission/nr04-busy/plain-fresh-input.txt',capture+'\n');
 receipt.freshInput=capture.split('\n').includes('RIG_NR04_FRESH_INPUT');assert.ok(receipt.freshInput);
 receipt.originalIdentityPreserved=true;receipt.geometryRestored=true;receipt.paneBirthIdSupported=receipt.initial.every(r=>r.split('|')[2].length>0);receipt.pass=true;
}catch(error){receipt.pass=false;receipt.error=String(error);}
finally{
 try{tmux('kill-server');}catch(error){receipt.cleanupError=String(error);}
 try{tmux('list-sessions');receipt.cleanup=false;}catch(error){receipt.cleanup=error.status===1&&/no server running|No such file or directory/.test(String(error.stderr));}
 receipt.protectedCliUnchanged=protectedHash===hash(repo+'/bin/cli.js');
 if(receipt.cleanup)rmSync(root,{recursive:true,force:true});
 for(let i=0;i<60&&[...ownedPids].some(alive);i++)await delay(50);
 receipt.remainingOwnedPids=[...ownedPids].filter(alive);receipt.ownedPidCount=ownedPids.size;receipt.cleanup=receipt.cleanup&&receipt.remainingOwnedPids.length===0&&!receipt.cleanupError;receipt.pass=Boolean(receipt.pass&&receipt.cleanup&&receipt.protectedCliUnchanged);
 receipt.privateRootRemoved=!existsSync(root);writeFileSync(output,JSON.stringify(receipt,null,2)+'\n');
}
console.log(JSON.stringify(receipt));if(!receipt.pass||!receipt.cleanup)process.exitCode=1;
