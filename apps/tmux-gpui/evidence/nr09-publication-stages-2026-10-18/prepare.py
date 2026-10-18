import pathlib,json,hashlib,shutil,difflib
root=pathlib.Path.cwd(); base=root/'.tasks/native-reliability-mission/nr09-publication-stages'; original=root/'.tasks/native-reliability-mission/nr01-current-payload/bridge/browser.bundle.mjs'
source=original.read_text(); s=source
start=s.index('function publish() {',s.index('function diagnosticTmuxVersion'))
end=s.index('\nasync function retire()',start)
part=s[start:end]
assert part.count('const line = JSON.stringify({')==1
part=part.replace('function publish() {','function publish() {\n  const nrStart = nrNow();',1)
part=part.replace('  const line = JSON.stringify({','  const nrEnvelopeStart = nrNow();\n  const nrEnvelope = {',1)
needle='  }) + "\\n";\n  if (Buffer.byteLength(line) > MAX_FRAME)'
assert part.count(needle)==1
part=part.replace(needle,'  };\n  const nrEnvelopeEnd = nrNow();\n  const line = JSON.stringify(nrEnvelope) + "\\n";\n  const nrStringifyEnd = nrNow();\n  const nrBytes = Buffer.byteLength(line);\n  if (nrBytes > MAX_FRAME)',1)
needle='  if (blocked) pending = line;\n  else blocked = !process.stdout.write(line);'
assert part.count(needle)==1
part=part.replace(needle,'  const nrSizeEnd = nrNow();\n  const nrWasBlocked = blocked;\n'+needle+'\n  nrRecord({kind:0,request:request3,sequence,frameKind:nrEnvelope.retainedPreview?1:nrEnvelope.snapshot?2:0,bytes:nrBytes,preludeUs:nrEnvelopeStart-nrStart,envelopeUs:nrEnvelopeEnd-nrEnvelopeStart,stringifyUs:nrStringifyEnd-nrEnvelopeEnd,sizeUs:nrSizeEnd-nrStringifyEnd,writeUs:nrNow()-nrSizeEnd,enqueued:nrWasBlocked?1:0});',1)
needle='    blocked = !process.stdout.write(line);'
assert part.count(needle)==1
part=part.replace(needle,'    const nrDrainStart=nrNow();\n'+needle+'\n    nrRecord({kind:1,writeUs:nrNow()-nrDrainStart});',1)
prefix='''import { writeFileSync as nrWrite } from "node:fs";
const nrRecords=[];
let nrOverflow=0;
const nrNow=()=>Number(process.hrtime.bigint()/1000n);
function nrRecord(value){ if(nrRecords.length<2048)nrRecords.push(value); else nrOverflow++; }
process.once("exit",()=>{ nrWrite(process.env.NR09_STAGE_PROFILE,JSON.stringify({version:1,overflow:nrOverflow,records:nrRecords})+"\\n",{flag:"wx",mode:0o600}); });
'''
s=prefix+s[:start]+part+s[end:]
bridge=base/'bridge';bridge.mkdir(exist_ok=True)
(bridge/'browser.bundle.mjs').write_text(s)
shutil.copyfile(original.with_name('live.bundle.mjs'),bridge/'live.bundle.mjs')
(base/'bundle.patch').write_text(''.join(difflib.unified_diff(source.splitlines(True),s.splitlines(True),fromfile='original/browser.bundle.mjs',tofile='instrumented/browser.bundle.mjs')))
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
(base/'provenance.json').write_text(json.dumps({'original':str(original),'originalSha256':h(original),'instrumentedSha256':h(bridge/'browser.bundle.mjs'),'liveOriginalSha256':h(original.with_name('live.bundle.mjs')),'liveCopiedSha256':h(bridge/'live.bundle.mjs')},indent=2)+'\n')
