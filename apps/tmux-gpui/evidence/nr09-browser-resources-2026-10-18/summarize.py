import json,statistics
from pathlib import Path
root=Path(__file__).resolve().parent
runs=[]
referenceHashes=None
for pair in range(1,6):
 for variant in ['baseline','candidate']:
  r=json.loads((root/f'pair-{pair}-{variant}.json').read_text())
  assert all(r[k] for k in ['passed','cleanup','hashesUnchanged','inputVerified','sourcePreserved'])
  if referenceHashes is None: referenceHashes=r['hashes']
  else: assert r['hashes']==referenceHashes
  p=r['resourceProfile'];s=p['samples'];assert p['failure'] is None and len(s)>11
  assert len({(x['pid'],x['ppid'],x['start']) for x in s})==1
  assert all(x['afterMs']>=x['beforeMs']>=x['requestedMs'] for x in s)
  assert all(b['beforeMs']>=a['afterMs'] and b['cpuSeconds']>=a['cpuSeconds'] for a,b in zip(s,s[1:]))
  b={x['label']:x for x in s if x['label']!='periodic'};e={x['label']:x['atMs'] for x in p['events']}
  switches=[]
  for n in [1,2,3]:
   start=b[f'switch-{n}-before-command'];end=b[f'switch-{n}-after-ready']
   assert start['afterMs']<=e[f'switch-{n}-command-write']<e[f'switch-{n}-ready-publication']<=end['beforeMs']
   switches.append(round(end['cpuSeconds']-start['cpuSeconds'],2))
  start=b['before-producer'];end=b['fresh-input-verified']
  busy=[x for x in s if x['beforeMs']>=start['beforeMs'] and x['afterMs']<=end['afterMs']]
  runs.append({'pair':pair,'variant':variant,'samples':len(s),'cpuDisplayQuantumSeconds':sorted({x['displayQuantumSeconds'] for x in s}),'busyCpuSeconds':round(end['cpuSeconds']-start['cpuSeconds'],2),'wholeObservedCpuSeconds':round(s[-1]['cpuSeconds']-s[0]['cpuSeconds'],2),'wholeObservedSampledRssMaxKiB':max(x['rssKiB'] for x in s),'busyWindowSampledRssMaxKiB':max(x['rssKiB'] for x in busy),'switchBoundaryCpuSeconds':switches,'maxPsCallMs':max(x['afterMs']-x['beforeMs'] for x in s),'maxSampleGapMs':max(y['beforeMs']-x['afterMs'] for x,y in zip(s,s[1:])),'valid':True})
metrics=['busyCpuSeconds','wholeObservedCpuSeconds','wholeObservedSampledRssMaxKiB','busyWindowSampledRssMaxKiB']
summary={'scope':'Five fresh-process pairs; browser only; pilots excluded','runs':runs,'summary':{}}
for metric in metrics:
 values={v:[r[metric] for r in runs if r['variant']==v] for v in ['baseline','candidate']}
 deltas=[round(c-b,6) for b,c in zip(values['baseline'],values['candidate'])]
 summary['summary'][metric]={v:{'values':a,'median':statistics.median(a),'min':min(a),'max':max(a)} for v,a in values.items()}
 summary['summary'][metric]['pairedCandidateMinusBaseline']={'values':deltas,'median':statistics.median(deltas),'min':min(deltas),'max':max(deltas)}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary['summary'],indent=2))
