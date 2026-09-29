// Preserve current bounded parser case cleanup; refuse the next case after cancellation.
globalThis.qualificationCancelled=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{globalThis.qualificationCancelled=true;});
