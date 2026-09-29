/** Private bounded diagnostics only; caller's cleanup failure remains a failure. */
export function cleanupDiagnostic(phase,error){
 const clip=(value,limit)=>{const text=String(value);return text.length<=limit?text:text.slice(0,limit-15)+'...[truncated]';};
 return {error:clip(error,2048),phase:clip(phase,80),code:error?.code===undefined?null:clip(error.code,64),syscall:error?.syscall===undefined?null:clip(error.syscall,64),path:error?.path===undefined?null:clip(error.path,1024),stack:error?.stack===undefined?null:clip(error.stack,8192)};
}
