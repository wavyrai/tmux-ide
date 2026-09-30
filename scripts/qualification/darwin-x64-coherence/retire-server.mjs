import assert from 'node:assert/strict';
// Reuses the accepted generation + kernel + socket fence. Injected IO permits offline refusal tests.
export async function retireServer(allocation,proof,io){
 const pid=Number(proof.generation.pid);assert(Number.isSafeInteger(pid)&&pid>0&&proof.kernelWitness);
 const observed=await io.identify(pid);
 if(observed===null)return {retired:true,alreadyAbsent:true};
 assert.equal(observed,proof.kernelWitness,'Server incarnation changed');
 const socket=io.socket(allocation.socketPath);assert(socket.isSocket&&socket.uid===io.uid);
 assert.deepEqual({dev:socket.dev,ino:socket.ino},proof.socketIdentity);
 await io.kill(allocation.socketPath,proof.generation);
 const end=io.now()+5000;
 while(await io.identify(pid)!==null&&io.now()<end)await io.sleep(25);
 assert.equal(await io.identify(pid),null,'Server exit unconfirmed');
 return {retired:true,alreadyAbsent:false};
}
