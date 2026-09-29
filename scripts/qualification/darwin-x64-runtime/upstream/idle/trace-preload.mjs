import {readFileSync,openSync,writeSync,closeSync} from 'node:fs';
import {createServer} from 'node:net';
import {installChildTrace} from './trace-hook.mjs';
const config=JSON.parse(readFileSync(new URL(import.meta.url).searchParams.get('config'),'utf8'));
// A fork may inherit --import; only the direct owned daemon is traced.
if(process.ppid===config.ownerPid){
const fd=openSync(config.log,'wx',0o600);let bytes=0,seq=0,phase='startup',failed=false;
function emit(event){
 if(failed)return;
 const line=JSON.stringify({seq:++seq,atNs:process.hrtime.bigint().toString(),phase,...event})+'\n';
 bytes+=Buffer.byteLength(line);
 if(bytes>1048576||seq>10000){failed=true;process.stderr.write('qualification trace overflow\n');process.exit(97);}
 try{const data=Buffer.from(line);if(writeSync(fd,data)!==data.length)throw Error('short trace write');}catch{failed=true;process.exit(98);}
}
installChildTrace(emit);
const server=createServer(socket=>{
 socket.setTimeout(1000,()=>socket.destroy());let data='';
 socket.on('error',()=>{});socket.on('data',chunk=>{
  data+=chunk.toString();if(data.length>256){socket.destroy();return;}
  if(!data.endsWith('\n'))return;
  try{const request=JSON.parse(data);if(!['idle','wake','cleanup'].includes(request.phase))throw Error('invalid phase');
   if(request.phase==='idle'&&phase!=='startup'||request.phase==='wake'&&phase!=='idle'||request.phase==='cleanup'&&phase==='cleanup')throw Error('invalid transition');
   phase=request.phase;emit({type:'phase',requestId:request.id});socket.end(JSON.stringify({id:request.id,phase,seq})+'\n');
  }catch{socket.destroy();}
 });
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.socket,resolve);});
server.unref();emit({type:'trace-ready',pid:process.pid});
process.on('exit',code=>{emit({type:'process-exit',code});closeSync(fd);});

}
