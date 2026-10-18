import pathlib,json,hashlib,shutil,difflib
root=pathlib.Path.cwd();base=root/'.tasks/native-reliability-mission/nr09-retained-serialization';src=root/'.tasks/native-reliability-mission/nr01-current-payload/bridge/browser.bundle.mjs';s=src.read_text();original=s
cacheStart=s.index('function createRetainedFrameCache() {');cacheEnd=s.index('\n// ',cacheStart)
cache=s[cacheStart:cacheEnd];assert cache.count('return JSON.parse(entry.json);')==1
s=s[:cacheStart]+cache.replace('return JSON.parse(entry.json);','return entry.json;')+s[cacheEnd:]
start=s.index('function publish() {',s.index('function diagnosticTmuxVersion'));end=s.index('\nasync function retire()',start);part=s[start:end]
assert part.count('  const line = JSON.stringify({')==1
part=part.replace('  const line = JSON.stringify({','  const nrPrefix = {',1)
needle='    retainedPreview: preview ? { snapshot: preview.snapshot } : null,'
assert part.count(needle)==1
part=part.replace(needle,'  };\n  const nrSuffix = {',1)
needle='  }) + "\\n";';assert part.count(needle)==1
part=part.replace(needle,'  };\n  const line = nrSerialize(nrPrefix, nrSuffix, preview ? preview.snapshot : null);',1)
helper='''function nrSerialize(prefix, suffix, snapshotJson) {
  if(snapshotJson === null) return JSON.stringify({...prefix,retainedPreview:null,...suffix})+"\\n";
  return JSON.stringify(prefix).slice(0,-1)+',"retainedPreview":{"snapshot":'+snapshotJson+'},'+JSON.stringify(suffix).slice(1)+"\\n";
}
'''
s=helper+s[:start]+part+s[end:]
b=base/'bridge';b.mkdir(exist_ok=True);(b/'browser.bundle.mjs').write_text(s);shutil.copyfile(src.with_name('live.bundle.mjs'),b/'live.bundle.mjs')
(base/'serializer.mjs').write_text(helper+'export {nrSerialize};\n')
# Cache source is self contained except Buffer and fixed constants.
(base/'cache.mjs').write_text('const Buffer2=Buffer;const MAX_ENTRIES=8,MAX_ENTRY_BYTES=4*1024*1024,MAX_TOTAL_BYTES=16*1024*1024;\n'+cache.replace('return JSON.parse(entry.json);','return entry.json;')+'\nexport {createRetainedFrameCache};\n')
(base/'bundle.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True),s.splitlines(True),fromfile='baseline/browser.bundle.mjs',tofile='candidate/browser.bundle.mjs')))
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
(base/'provenance.json').write_text(json.dumps({'sourceCommit':'873ef58e24b449ec040f0f653b0c221a6623c5e0','baseline':h(src),'candidate':h(b/'browser.bundle.mjs'),'liveBaseline':h(src.with_name('live.bundle.mjs')),'liveCandidate':h(b/'live.bundle.mjs')},indent=2)+'\n')
