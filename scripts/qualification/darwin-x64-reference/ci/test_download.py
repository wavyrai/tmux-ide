import io,importlib.util,pathlib,tempfile,unittest,hashlib,sys,json
from unittest.mock import patch
HERE=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
spec=importlib.util.spec_from_file_location('reference_prepare',HERE/'prepare.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Download(unittest.TestCase):
 def test_held_flag_refuses_before_output_creation(self):
  with tempfile.TemporaryDirectory() as d:
   holder=pathlib.Path(d);(holder/'pins.json').write_text(json.dumps({'executionAuthorized':False}))
   with patch.object(m,'HERE',holder),patch.object(m.platform,'system',return_value='Darwin'),patch.object(m.platform,'machine',return_value='x86_64'),patch.object(sys,'argv',['prepare','--metadata','missing','--archive','missing','--output',str(holder/'output')]):
    with self.assertRaisesRegex(AssertionError,'not authorized'):m.main()
   self.assertFalse((holder/'output').exists())
 def test_hash_bound(self):
  with tempfile.TemporaryDirectory() as d,patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(b'abc')):
   p=pathlib.Path(d)/'input';r=m.download('fixed-url',p,hashlib.sha256(b'abc').hexdigest(),3);self.assertEqual(r['bytes'],3)
 def test_oversize_rejected_before_write(self):
  with tempfile.TemporaryDirectory() as d,patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(b'abcd')):
   p=pathlib.Path(d)/'input'
   with self.assertRaisesRegex(AssertionError,'cap'):m.download('fixed-url',p,'x',3)
   self.assertEqual(p.stat().st_size,0)
 def test_wrong_hash_refused(self):
  with tempfile.TemporaryDirectory() as d,patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(b'abc')):
   with self.assertRaisesRegex(AssertionError,'hash'):m.download('fixed-url',pathlib.Path(d)/'input','0'*64,3)
if __name__=='__main__':unittest.main()
