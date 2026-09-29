"""Original 18-case parser callback gate, no consumed-paint claim."""
import math,statistics
MODES=['reference','disabled','enabled','reader-0','reader-16','reader-32']
def distribution(samples):
 values=sorted(s['latencyMs'] for s in samples)
 assert values and all(math.isfinite(x) and x>=0 for x in values)
 return {'p50Ms':values[math.ceil(.5*len(values))-1],'p95Ms':values[math.ceil(.95*len(values))-1],'p99Ms':values[math.ceil(.99*len(values))-1]}
def validate(rows):
 assert len(rows)==18 and [(r['round'],r['mode']) for r in rows]==[(i,m) for i in range(3) for m in MODES[i:]+MODES[:i]]
 groups={m:[] for m in MODES}
 for r in rows:
  assert r['status']=='passed' and not r.get('error') and not r.get('cleanupFailed')
  assert r['target']=='tmux' and r['inputMode']=='key'
  assert r['cleanup'] and all('error' not in c for c in r['cleanup'])
  assert any(c.get('absenceProved') is True and c.get('socketAbsent') is True for c in r['cleanup'])
  samples=r['samples'];assert len(samples)==202
  assert [s['sequence'] for s in samples]==list(range(1,203))
  assert all(s['warmup']==(s['sequence']<=2) for s in samples)
  assert [p['sequence'] for p in r['producer']]==list(range(1,203))
  assert len(r['resizeSamples'])==10
  for i,s in enumerate(r['resizeSamples']):assert s['index']==i and (s['cols'],s['rows'])==((104,32) if i%2==0 else (100,30))
  for s in samples+r['resizeSamples']:
   assert math.isfinite(s['inputAtMs']) and math.isfinite(s['visibleAtMs']) and s['visibleAtMs']>=s['inputAtMs']
   assert math.isfinite(s['latencyMs']) and s['latencyMs']>=0 and abs(s['latencyMs']-(s['visibleAtMs']-s['inputAtMs']))<=1e-6
  groups[r['mode']].append({'round':r['round'],'samples':200,'warmups':2,'resizeObservations':10,**distribution(samples[2:]),'resize':distribution(r['resizeSamples'])})
 baseline=statistics.median(r['p95Ms'] for r in groups['disabled']);result={}
 for mode,rounds in groups.items():
  median=statistics.median(r['p95Ms'] for r in rounds);delta=median-baseline;passed=None if mode=='reference' else delta<=1
  result[mode]={'rounds':rounds,'medianRoundP95Ms':median,'deltaVsDisabledMs':delta,'passed':passed}
  assert passed is not False,(mode,result[mode])
 return {'passed':True,'cases':18,'modes':result,'limits':{'medianRoundP95DeltaMs':1},'endpoint':'stock xterm-headless parse callback, not consumed paint','cpuDiagnosticOnly':True}
