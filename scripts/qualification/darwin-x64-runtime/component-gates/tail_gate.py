"""Original three tail/backlog cases, every phase and command timing gate."""
import math
from metadata_report import distribution
PHASE_PAIRS=[1,256,1,256,1,256,1,256,1,471]
def validate(rows):
 assert len(rows)==3 and [(r['round'],r['mode']) for r in rows]==[(1,'candidate-'+str(m)) for m in [0,16,32]]
 result={}
 for r in rows:
  assert r['error'] is None and r['n']==r['count']==1500 and not any('error' in c for c in r['cleanup'])
  assert any(c.get('absenceProved') is True for c in r['cleanup'])
  s=r['stats'];assert s['records']==6002 and s['last']=='6002' and s['gaps']==0
  assert s['kinds']=={'1':1500,'5':1500,'2':1501,'6':1501}
  assert s['effects']=={'input-enqueued':1500,'snapshot-produced':1501}
  assert s['enricherPending']==0 and s['retained']==256 and s['journalCursor']==s['published']==3001
  samples=r['latency_samples'];assert len(samples)==6002 and all(math.isfinite(x['milliseconds']) and x['milliseconds']>=0 for x in samples)
  per=distribution(samples);assert per['commands']==3001 and per['passed'],per
  phases=r['phases'];assert len(phases)==10
  # Native batch sizes map to contiguous telemetry offsets, permitting independent
  # verification that each burst included a full64 record batch with next!=newest.
  batch_ranges=[];cursor=0
  for b in r['observed_batches']:
   assert isinstance(b['batchSize'],int) and 0<=b['batchSize']<=64
   batch_ranges.append((cursor,cursor+b['batchSize'],b));cursor+=b['batchSize']
  assert cursor==6002
  cursor=0;details=[]
  for phase,size in zip(phases,PHASE_PAIRS):
   end=cursor+4*size
   assert phase['pairs']==size and phase['kind']==('quiet-tail' if size==1 else 'backlog')
   assert phase['sampleStart']==cursor and phase['sampleEnd']==end
   batches=[b for lo,hi,b in batch_ranges if lo>=cursor and hi<=end and hi>lo]
   assert sum(b['batchSize'] for b in batches)==4*size
   assert phase['backloggedBatches']==sum(bool(b['backlog']) for b in batches)
   if size>1:
    assert any(b['backlog'] and b['batchSize']==64 for b in batches)
    proof=phase['sourceFile'];assert proof['pairs']==size and proof['commands']==2*size and 0<proof['bytes']<=32768
   else:assert phase['sourceFile'] is None
   timing=distribution(samples[cursor:end]);assert timing['commands']==2*size and timing['passed'],timing
   details.append({**phase,**timing});cursor=end
  assert cursor==6000 # exactly one final capture adds the remaining command/effect
  result[r['mode']]={'runs':[per],'pooled':per,'phases':details,'passed':True}
 return {'passed':True,'cases':3,'modes':result,'limits':{'p99Ms':50,'maxMs':100},'cpuDiagnosticOnly':True}
