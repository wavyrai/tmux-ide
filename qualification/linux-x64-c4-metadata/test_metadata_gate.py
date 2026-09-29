import pathlib,sys,copy,unittest,math
R=pathlib.Path(__file__).resolve().parent;sys.path[:0]=[str(R),str(R.parent/'linux-x64-c4-components/port/metadata')]
from metadata_gate import validate

def rows():
 result=[]
 for i,order in enumerate([[0,16,32],[32,16,0],[16,0,32]],1):
  for mode in order:
   result.append(dict(round=i,mode='candidate-'+str(mode),error=None,n=1500,count=1500,cleanup=[{'absenceProved':True}],stats=dict(records=6002,last='6002',gaps=0,kinds={'1':1500,'5':1500,'2':1501,'6':1501},enricherPending=0,retained=256,journalCursor=3001,published=3001),latency_samples=[{'kind':1 if j<3001 else 5,'milliseconds':1} for j in range(6002)]))
 return result
class Gate(unittest.TestCase):
 def test_all_nine_and_pooled(self):
  v=validate(rows());self.assertEqual(v['cases'],9);self.assertTrue(all(x['pooled']['commands']==9003 for x in v['modes'].values()))
 def test_order_count_pending_cleanup_and_missing_case_reject(self):
  for mutate in [lambda r:r.pop(),lambda r:r[0].update(mode='candidate-32'),lambda r:r[0]['stats'].update(records=6001),lambda r:r[0]['stats'].update(enricherPending=1),lambda r:r[0].update(cleanup=[]),lambda r:r[0]['cleanup'].append({'error':'uncertain'})]:
   v=rows();mutate(v)
   with self.assertRaises(AssertionError):validate(v)
 def test_per_case_cannot_hide_in_pool(self):
  v=rows()
  for sample in v[0]['latency_samples'][:31]:sample['milliseconds']=51
  with self.assertRaises(AssertionError):validate(v)
 def test_max_and_nonfinite_reject(self):
  for value in [101,float('nan'),float('inf'),-1]:
   v=rows();v[0]['latency_samples'][0]['milliseconds']=value
   with self.assertRaises((AssertionError,ValueError)):validate(v)
if __name__=='__main__':unittest.main()
