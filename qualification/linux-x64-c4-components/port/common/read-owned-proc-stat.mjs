import assert from 'node:assert/strict';
/** Only this exact proc-stat read can be reopened once after its task vanished mid-read. */
export async function readOwnedProcStat(pid,read){
 assert(Number.isSafeInteger(pid)&&pid>0,'Invalid owned PID');
 const path=`/proc/${pid}/stat`;
 const once=async()=>{try{return await read(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 try{return await once();}
 catch(error){
  if(error.code!=='ESRCH'||error.syscall!=='read'||error.path!==path)throw error;
  // ESRCH alone does not mean the numeric PID is absent: reopen, then let the
  // existing sampler distinguish present/reused/zombie/malformed/absent.
  return await once();
 }
}
