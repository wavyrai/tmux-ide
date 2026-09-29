import pathlib,sys,copy,unittest
R=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(R))
from parser_gate import validate,MODES

def rows():
 return [{'round':i,'mode':m,'status':'passed','target':'tmux','inputMode':'key','cleanup':[{'absenceProved':True,'socketAbsent':True}],
 'samples':[{'sequence':j,'warmup':j<=2,'inputAtMs':float(j),'visibleAtMs':j+2.,'latencyMs':2.} for j in range(1,203)],
 'producer':[{'sequence':j} for j in range(1,203)],'resizeSamples':[{'index':j,'cols':104 if j%2==0 else 100,'rows':32 if j%2==0 else 30,'inputAtMs':float(j),'visibleAtMs':j+2.,'latencyMs':2.} for j in range(10)]} for i in range(3) for m in MODES[i:]+MODES[:i]]
class Gate(unittest.TestCase):
 def test_exact_original_contract(self):
  result=validate(rows());self.assertEqual(result['cases'],18);self.assertIsNone(result['modes']['reference']['passed'])
 def test_counts_order_warmups_cleanup_fail_closed(self):
  for mutate in [lambda r:r.pop(),lambda r:r[0].update(mode='disabled'),lambda r:r[0]['samples'].pop(),lambda r:r[0]['samples'][0].update(warmup=False),lambda r:r[0]['resizeSamples'].pop(),lambda r:r[0]['producer'].pop(),lambda r:r[0].update(cleanupFailed=True),lambda r:r[0].update(cleanup=[{'absenceProved':True,'socketAbsent':False}])]:
   v=rows();mutate(v)
   with self.assertRaises(AssertionError):validate(v)
 def test_median_round_p95_not_pool_or_worst_round(self):
  v=rows()
  for r in v:
   if r['mode']=='reader-32' and r['round']==0:
    for s in r['samples']:s.update(latencyMs=50.,visibleAtMs=s['inputAtMs']+50.)
  self.assertTrue(validate(v)['modes']['reader-32']['passed'])
  for r in v:
   if r['mode']=='reader-32' and r['round']==1:
    for s in r['samples']:s.update(latencyMs=3.001,visibleAtMs=s['inputAtMs']+3.001)
  with self.assertRaises(AssertionError):validate(v)
 def test_original_one_ms_boundary(self):
  v=rows()
  for r in v:
   if r['mode']=='enabled':
    for s in r['samples']:s.update(latencyMs=3.,visibleAtMs=s['inputAtMs']+3.)
  self.assertTrue(validate(v)['modes']['enabled']['passed'])
 def test_bad_timestamps_and_resize(self):
  for mutate in [lambda r:r[0]['samples'][2].update(latencyMs=float('nan')),lambda r:r[0]['samples'][2].update(visibleAtMs=0),lambda r:r[0]['resizeSamples'][0].update(cols=100)]:
   v=rows();mutate(v)
   with self.assertRaises(AssertionError):validate(v)
if __name__=='__main__':unittest.main()
