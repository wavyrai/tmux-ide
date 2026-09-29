import ast,pathlib,json,hashlib,tempfile,unittest
from validate_receipts import validate_preparation_receipts as validate
class Receipts(unittest.TestCase):
 def fixture(self,temp):
  root=pathlib.Path(temp);e=root
  rows={'coherence-build-result':{'exit':0,'postClosurePassed':True,'performanceQualified':False},'bootstrap-status':{'code':0},'coherence-receipt':{'fixturesStarted':False,'originalClosureUnchanged':True,'source':{'commit':'be8bcfad29610265716b8dcb657658cf8f1d0ba3'},'stock':{'patches':[]},'buildInputs':dict.fromkeys(map(str,range(401)),'hash'),'closure':dict.fromkeys(map(str,range(4001)),'hash')},'payload-proof':{'roundtripVerified':True,'gitIncluded':True,'members':1,'ledger':{'current':{}}},'coherence-archive':{'roundtripVerified':True,'bytes':7,'sha256':hashlib.sha256(b'archive').hexdigest()}}
  for stage in ['coherence-import','coherence-tests','cli-build','cli-version','source-clean-after-build','source-self-contained','stock-autogen','stock-configure','stock-build','stock-version','coherence-collect']:rows[stage+'-status']={'exit':0,'truncated':False}
  for name,value in rows.items():(e/(name+'.json')).write_text(json.dumps(value))
  (e/'coherence-runtime.tar').write_bytes(b'archive');return root
 def test_all_mandatory_receipts(self):
  with tempfile.TemporaryDirectory() as d:validate(self.fixture(d))
 def test_missing_failed_corrupt_and_patched_stock_rejected(self):
  for name in ['coherence-receipt','payload-proof','source-self-contained-status','coherence-import-status']:
   with tempfile.TemporaryDirectory() as d:
    r=self.fixture(d);(r/f'{name}.json').unlink()
    with self.assertRaises(FileNotFoundError):validate(r)
  for name,field,value in [('coherence-build-result','exit',1),('payload-proof','gitIncluded',False),('stock-build-status','truncated',True),('coherence-receipt','stock',{'patches':['native-grid.patch']})]:
   with tempfile.TemporaryDirectory() as d:
    r=self.fixture(d);p=r/f'{name}.json';data=json.loads(p.read_text());data[field]=value;p.write_text(json.dumps(data))
    with self.assertRaises(AssertionError):validate(r)
  with tempfile.TemporaryDirectory() as d:
   r=self.fixture(d);(r/'coherence-runtime.tar').write_bytes(b'changed')
   with self.assertRaises(AssertionError):validate(r)
if __name__=='__main__':unittest.main()
