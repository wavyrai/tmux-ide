import cp from 'node:child_process';
import {resolveChildExecutable} from './trace-executable.mjs';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
export function installChildTrace(emit) {
 const names=['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork'];
 const originals=new Map(names.map(n=>[n,cp[n]]));let depth=0,next=0;
 for(const api of names){
  const original=originals.get(api);
  function wrapped(...args){
   if(depth)return Reflect.apply(original,this,args);
   const id=++next;const argv=Array.isArray(args[1])?args[1]:[];
   const options=args.find((a,i)=>i>0&&a&&typeof a==='object'&&!Array.isArray(a));
   const shell=api==='exec'||api==='execSync'||!!options?.shell;
   const executable=api==='fork'?(options?.execPath??process.execPath):String(args[0]);
   emit({type:'attempt',id,api,executable,argv,shell,executableResolved:shell?null:resolveChildExecutable(executable,options)});
   let result;depth++;
   try{result=Reflect.apply(original,this,args);}catch(e){emit({type:'throw',id,error:String(e)});throw e;}finally{depth--;}
   if(api.endsWith('Sync'))emit({type:'sync-complete',id,pid:result?.pid??null,status:api==='spawnSync'?result.status:0,signal:api==='spawnSync'?(result.signal??null):null,error:result?.error?String(result.error):null});
   else {
    emit({type:'spawn-return',id,pid:result.pid??null});
    result.once('spawn',()=>emit({type:'spawn',id,pid:result.pid}));
    result.once('error',e=>emit({type:'error',id,error:String(e)}));
    result.once('exit',(code,signal)=>emit({type:'exit',id,pid:result.pid??null,code,signal}));
   }
   return result;
  }
  if(api==='exec'||api==='execFile')Object.defineProperty(wrapped,promisify.custom,{value:(...args)=>{
   let child;const promise=new Promise((resolve,reject)=>{child=wrapped(...args,(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr}));});
   promise.child=child;return promise;
  }});
  cp[api]=wrapped;
 }
 syncBuiltinESMExports();
 return ()=>{for(const [name,fn] of originals)cp[name]=fn;syncBuiltinESMExports();};
}
