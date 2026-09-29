import pathlib,sys,copy,unittest
R=pathlib.Path(__file__).resolve().parent;sys.path[:0]=[str(R),str(R.parent/'linux-x64-c4-components/port/tail')]
from tail_gate import validate,PHASE_PAIRS

def rows():
 result=[]
 for mode in [0,16,32]:
  samples=[];phases=[];batches=[]
  for size in PHASE_PAIRS:
   start=len(samples);samples += [{'kind':1 if j%2==0 else 5,'milliseconds':1} for j in range(size*4)]
   remain=size*4;backlogs=0
   while remain:
    n=min(64,remain);remain-=n;backlog=remain>0;backlogs+=backlog;batches.append({'batchSize':n,'backlog':backlog})
   phases.append({'kind':'quiet-tail' if size==1 else 'backlog','pairs':size,'sourceFile':None if size==1 else {'pairs':size,'commands':size*2,'bytes':size*40},'sampleStart':start,'sampleEnd':len(samples),'backloggedBatches':backlogs})
  samples += [{'kind':2,'milliseconds':1},{'kind':6,'milliseconds':1}];batches.append({'batchSize':2,'backlog':False})
  result.append(dict(round=1,mode='candidate-'+str(mode),error=None,n=1500,count=1500,cleanup=[{'absenceProved':True}],stats=dict(records=6002,last='6002',gaps=0,kinds={'1':1500,'5':1500,'2':1501,'6':1501},effects={'input-enqueued':1500,'snapshot-produced':1501},enricherPending=0,retained=256,journalCursor=3001,published=3001),latency_samples=samples,phases=phases,observed_batches=batches))
 return result
class Gate(unittest.TestCase):
 def test_complete(self):
  v=validate(rows());self.assertEqual(v['cases'],3);self.assertTrue(all(len(x['phases'])==10 for x in v['modes'].values()))
 def test_missing_reordered_and_incomplete_counts(self):
  for mutate in [lambda r:r.pop(),lambda r:r[0].update(mode='candidate-32'),lambda r:r[0]['stats'].update(records=6001),lambda r:r[0].update(cleanup=[]),lambda r:r[0]['phases'][0].update(sampleEnd=3),lambda r:r[0]['observed_batches'].pop()]:
   v=rows();mutate(v)
   with self.assertRaises(AssertionError):validate(v)
 def test_quiet_tail_latency_cannot_hide_in_case_distribution(self):
  v=rows();v[0]['latency_samples'][0]['milliseconds']=51
  with self.assertRaises(AssertionError):validate(v)
 def test_backlog_requires_full64_and_causal_phase_match(self):
  for mutate in [lambda r:r[0]['phases'][1].update(backloggedBatches=0),lambda r:r[0]['phases'][1].update(sourceFile=None),lambda r:r[0]['observed_batches'][1].update(backlog=False),lambda r:r[0]['observed_batches'][1].update(batchSize=63)]:
   v=rows();mutate(v)
   with self.assertRaises((AssertionError,TypeError)):validate(v)
 def test_invalid_clock_and_max_refused(self):
  for value in [float('nan'),float('inf'),-1,101]:
   v=rows();v[0]['latency_samples'][-2]['milliseconds']=value
   with self.assertRaises(AssertionError):validate(v)
if __name__=='__main__':unittest.main()
