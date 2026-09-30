import assert from 'node:assert/strict';
export const clientFormat='#{client_name}\t#{client_pid}\t#{client_tty}\t#{client_width}\t#{client_height}\t#{client_control_mode}\t#{session_name}';
export function createAttachDiagnostics(){
 let bytes=Buffer.alloc(0),total=0,exit=null,cleanup=false,ready=null,clients='';
 return {
  data(chunk){const b=Buffer.from(chunk);total+=b.length;bytes=Buffer.concat([bytes,b]).subarray(-65536);},
  exited(event){exit={exitCode:event.exitCode??null,signal:event.signal??null,duringCleanup:cleanup};},
  cleanupStarted(){cleanup=true;},
  observe(raw,expected){
   assert.equal(exit,null,'Owned PTY exited before attachment readiness');
   assert(Buffer.byteLength(raw)<=16384,'Client inventory exceeds diagnostic bound');clients=raw;
   const rows=raw.trimEnd()?raw.trimEnd().split('\n').map(line=>line.split('\t')):[];
   assert(rows.every(row=>row.length===7),'Malformed tmux client inventory');
   const matches=rows.filter(row=>row[1]===String(expected.pid));assert(matches.length<=1,'Duplicate owned PTY client');
   if(!matches.length)return false;
   const [name,pid,tty,width,height,control,session]=matches[0];
   assert.equal(session,expected.session,'Owned PTY attached wrong session');
   assert.equal(control,'0','Owned PTY is a control client');assert(tty.startsWith('/dev/'),'Owned PTY has no terminal');
   if(Number(width)!==expected.cols||Number(height)!==expected.rows)return false;
   ready={pid:Number(pid),name,tty,width:Number(width),height:Number(height),session};return true;
  },
  snapshot(){return {ready,exit,output:bytes.toString('utf8'),outputBytes:total,truncated:total>bytes.length,clients};}
 };
}
