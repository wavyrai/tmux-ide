import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const repo=process.cwd(), output=repo+'/.tasks/native-reliability-mission/nr04-actions/plain-actions.json';
mkdirSync(repo+'/.tasks/native-reliability-mission/nr04-actions',{recursive:true});
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
const receipt={lane:'plain-tmux',actionPath:'Direct split-window, resize-pane -Z twice and kill-pane; reference commands, not UI confirmation',tmuxVersion:execFileSync(binary,['-V'],{encoding:'utf8'}).trim(),tmuxSha256:hash(binary),node:process.version};
try{
 tmux('-f','/dev/null','new-session','-d','-s','nr04','-x','132','-y','41',"printf 'RIG_NR04_LEFT_CONTENT\\n'; exec /bin/sh -i");
 tmux('set-option','-t','nr04','status','off');tmux('set-window-option','-t','nr04:0','window-size','manual');tmux('set-window-option','-t','nr04:0','pane-border-status','top');receipt.headerPolicy='Explicit pane-border-status top matches TUI-adopted source content geometry; plain default differs';
 tmux('resize-window','-t','nr04:0','-x','132','-y','41');
 await delay(150);receipt.initial=snapshot();
 ownedPids.add(Number(tmux('display-message','-p','#{pid}')));ownedPids.add(Number(receipt.initial[0].split('|')[1]));
 assert.equal(receipt.initial.length,1);const original=receipt.initial[0].split('|')[0];
 const added=tmux('split-window','-h','-d','-P','-F','#{pane_id}','-t',original,"printf 'RIG_NR04_RIGHT_CONTENT\\n'; exec /bin/sh -i");
 await delay(150);receipt.split=snapshot();assert.equal(receipt.split.length,2);assert.deepEqual(receipt.split.map(r=>r.split('|').slice(3,9)),[['0','1','66','40','132','41'],['67','1','65','40','132','41']]);
 receipt.splitMarkers=receipt.split.every((r,i)=>tmux('capture-pane','-p','-t',r.split('|')[0]).split('\n').includes(i===0?'RIG_NR04_LEFT_CONTENT':'RIG_NR04_RIGHT_CONTENT'));assert.ok(receipt.splitMarkers);
 const addedRow=receipt.split.find(r=>r.split('|')[0]===added);assert.ok(addedRow);const addedPid=Number(addedRow.split('|')[1]);ownedPids.add(addedPid);
 assert.deepEqual(identity(receipt.split).filter(r=>r.startsWith(original+'|')),identity(receipt.initial));
 tmux('resize-pane','-Z','-t',original);receipt.zoomed=snapshot();assert.ok(receipt.zoomed.every(r=>r.split('|')[9]==='1'));assert.deepEqual(receipt.zoomed.find(r=>r.split('|')[0]===original).split('|').slice(0,9),receipt.initial[0].split('|').slice(0,9));
 tmux('resize-pane','-Z','-t',original);receipt.unzoomed=snapshot();assert.deepEqual(receipt.unzoomed,receipt.split);
 tmux('kill-pane','-t',added);receipt.closed=snapshot();assert.deepEqual(receipt.closed,receipt.initial);
 for(let i=0;i<60&&alive(addedPid);i++)await delay(50);receipt.closedPaneExited=!alive(addedPid);assert.ok(receipt.closedPaneExited);
 receipt.restored=receipt.closed;
 receipt.contentPreserved=receipt.initial.every((r,i)=>tmux('capture-pane','-p','-t',r.split('|')[0]).split('\n').includes(i===0?'RIG_NR04_LEFT_CONTENT':'RIG_NR04_RIGHT_CONTENT'));
 assert.ok(receipt.contentPreserved);
 const pane=receipt.initial[0].split('|')[0];tmux('send-keys','-t',pane,'-l',"printf 'RIG_NR04_FRESH_INPUT\\n'");tmux('send-keys','-t',pane,'Enter');await delay(100);
 const capture=tmux('capture-pane','-p','-t',pane);writeFileSync(repo+'/.tasks/native-reliability-mission/nr04-actions/plain-fresh-input.txt',capture+'\n');
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
