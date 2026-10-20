import json, pathlib, collections, sys
base=pathlib.Path(__file__).resolve().parent
r=json.loads((base/'quiet.json').read_text())
p=json.loads((base/'quiet-profile/browser.cpuprofile').read_text())
assert p['endTime'] > p['startTime']
assert len(p['samples'])==len(p['timeDeltas']) and all(d>=0 for d in p['timeDeltas'])
nodes={n['id']:n for n in p['nodes']}; weights=collections.Counter(); now=p['startTime']; stamps=[]
for ident,delta in zip(p['samples'],p['timeDeltas']):
    now+=delta; stamps.append(now); weights[ident]+=delta
assert now<=p['endTime'], (now,p['endTime'])
def rows(counter):
    return [{'function':nodes[i]['callFrame']['functionName'], 'url':nodes[i]['callFrame']['url'],'line':nodes[i]['callFrame']['lineNumber']+1,'sampleWeightUs':w,'fractionOfSampleWeight':w/sum(counter.values())} for i,w in counter.most_common(25)]
aggregated=collections.Counter()
for i,w in weights.items():
    f=nodes[i]['callFrame']; aggregated[(f['functionName'],f['url'],f['lineNumber']+1)]+=w
aggregateRows=[{'function':k[0],'url':k[1],'line':k[2],'sampleWeightUs':w,'fractionOfSampleWeight':w/sum(weights.values())} for k,w in aggregated.most_common(25)]
summary={'aggregatedExclusiveTop':aggregateRows,'scope':'whole owned browser lifecycle only; profile and harness monotonic clocks did not align; no switch filtering','instrumented':True,'osCpuUtilization':None,'nativeRendering':False,'profileDurationUs':p['endTime']-p['startTime'],'sampleWeightUs':sum(p['timeDeltas']),'samples':len(p['samples']),'clockValidated':r['profile']['clockValidated'],'cumulativeSamplesWithinProfile':True,'exclusiveTop':rows(weights)}
(base/'analysis.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
