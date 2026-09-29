import {connect} from 'node:net';import {randomUUID} from 'node:crypto';
export function tracePhase(socketPath,phase){return new Promise((resolve,reject)=>{
 const id=randomUUID(),socket=connect(socketPath);let data='';const timer=setTimeout(()=>{socket.destroy();reject(Error('trace phase timeout'));},1000);
 const fail=e=>{clearTimeout(timer);socket.destroy();reject(e);};socket.once('error',fail);
 socket.once('connect',()=>socket.write(JSON.stringify({id,phase})+'\n'));
 socket.on('data',chunk=>{data+=chunk;if(data.length>1024)return fail(Error('trace ack overflow'));if(data.endsWith('\n')){try{const ack=JSON.parse(data);if(ack.id!==id||ack.phase!==phase)throw Error('trace ack mismatch');clearTimeout(timer);socket.destroy();resolve(ack);}catch(e){fail(e);}}});
 socket.once('end',()=>{if(!data.endsWith('\n'))fail(Error('trace ack incomplete'));});
});}
