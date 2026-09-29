"""Nine exact runs and unchanged per-run/pooled metadata gates; no sample selection."""
from metadata_report import distribution

def validate(rows):
 orders=[['candidate-0','candidate-16','candidate-32'],['candidate-32','candidate-16','candidate-0'],['candidate-16','candidate-0','candidate-32']]
 assert len(rows)==9 and [(r['round'],r['mode']) for r in rows]==[(i+1,m) for i,order in enumerate(orders) for m in order]
 for r in rows:
  assert r['error'] is None and r['n']==1500 and r['count']==1500 and not any('error' in c for c in r['cleanup'])
  assert any(c.get('absenceProved') is True for c in r['cleanup'])
  s=r['stats'];assert s['records']==6002 and s['last']=='6002' and s['gaps']==0
  assert s['kinds']['1']==1500 and s['kinds']['5']==1500 and s['kinds']['2']==1501 and s['kinds']['6']==1501
  assert s['enricherPending']==0 and s['retained']==256 and s['journalCursor']==3001 and s['published']==3001
  samples=r['latency_samples'];assert len(samples)==6002 and all(x['milliseconds']>=0 for x in samples)
  per=distribution(samples);assert per['commands']==3001 and per['passed'],per
 result={}
 for mode in orders[0]:
  selected=[r for r in rows if r['mode']==mode];assert len(selected)==3
  per=[distribution(r['latency_samples']) for r in selected];pooled=distribution([x for r in selected for x in r['latency_samples']]);assert pooled['commands']==9003 and pooled['passed'],pooled
  result[mode]={'runs':per,'pooled':pooled,'passed':True}
 return {'passed':True,'cases':9,'modes':result,'limits':{'p99Ms':50,'maxMs':100},'cpuDiagnosticOnly':True}
