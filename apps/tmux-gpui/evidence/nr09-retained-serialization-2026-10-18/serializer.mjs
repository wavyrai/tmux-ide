function nrSerialize(prefix, suffix, snapshotJson) {
  if(snapshotJson === null) return JSON.stringify({...prefix,retainedPreview:null,...suffix})+"\n";
  return JSON.stringify(prefix).slice(0,-1)+',"retainedPreview":{"snapshot":'+snapshotJson+'},'+JSON.stringify(suffix).slice(1)+"\n";
}
export {nrSerialize};
