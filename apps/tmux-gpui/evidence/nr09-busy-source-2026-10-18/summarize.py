import json,pathlib,statistics
b=pathlib.Path(__file__).resolve().parent
metrics=['firstRetainedMs','firstFreshMs','firstInputReadyMs','publications','bytes','retainedFrames']
variants={}
for v in ['baseline','candidate']:
 rows=[]
 for i in range(1,6):
  r=json.loads((b/f'pair-{i}-{v}.json').read_text());assert r['passed'] and r['cleanup'] and r['hashesUnchanged']
  rows.append({'pair':i,**{k:statistics.median(s[k] for s in r['switches']) for k in metrics},'emptyFrames':sum(s['emptyFrames'] for s in r['switches'])})
 variants[v]={'runs':rows,'aggregate':{k:{'medianOfRunMedians':statistics.median(r[k] for r in rows),'minRunMedian':min(r[k] for r in rows),'maxRunMedian':max(r[k] for r in rows)} for k in metrics}}
deltas=[{'pair':i+1,**{k:variants['candidate']['runs'][i][k]-variants['baseline']['runs'][i][k] for k in metrics}} for i in range(5)]
s={'scope':'five fresh-process runs per variant; three correlated busy switches per run; no pilots pooled; frozen serializer candidate','variants':variants,'pairedCandidateMinusBaseline':deltas,'pairedMedianDelta':{k:statistics.median(r[k] for r in deltas) for k in metrics}}
(b/'summary.json').write_text(json.dumps(s,indent=2)+'\n');print(json.dumps(s,indent=2))
