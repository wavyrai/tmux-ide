import json,math,sys
from pathlib import Path
def distribution(samples):
 values=sorted(s['milliseconds'] for s in samples if s['kind']<=4)
 if not values or any(not math.isfinite(v) or v<0 for v in values):raise ValueError('Invalid metadata clock samples')
 result={'commands':len(values),'p99Ms':values[math.ceil(.99*len(values))-1],'maxMs':values[-1]}
 return {**result,'passed':result['p99Ms']<=50 and result['maxMs']<=100}
def main():
 p=Path(__file__).resolve().parent;out={}
 for filename,expected in [('metadata-results.json',9),('tail-backlog-results.json',3)]:
  rows=json.loads((p/filename).read_text())['runs'];assert len(rows)==expected
  for r in rows:
   assert r['error'] is None and r['cleanup'] and all('error' not in c for c in r['cleanup'])
   assert r['stats']['records']==6002 and r['stats']['published']==3001 and r['stats']['gaps']==0 and r['stats']['enricherPending']==0
   assert len(r['latency_samples'])==6002
  out[filename]={}
  for mode in ['candidate-0','candidate-16','candidate-32']:
   selected=[r for r in rows if r['mode']==mode];assert len(selected)==expected//3
   runs=[distribution(r['latency_samples']) for r in selected];assert all(d['commands']==3001 for d in runs)
   details=[]
   for r in selected:
    for phase in r.get('phases',[]):details.append({**phase,**distribution(r['latency_samples'][phase['sampleStart']:phase['sampleEnd']])})
   combined=distribution([s for r in selected for s in r['latency_samples']])
   out[filename][mode]={'runs':runs,'combined':combined,'phases':details,'passed':combined['passed'] and all(d['passed'] for d in runs+details)}
 (p/'metadata-summary.json').write_text(json.dumps(out,indent=2));print(json.dumps(out,indent=2))
 if any(not mode['passed'] for lane in out.values() for mode in lane.values()):raise SystemExit(1)
if __name__=='__main__':main()
