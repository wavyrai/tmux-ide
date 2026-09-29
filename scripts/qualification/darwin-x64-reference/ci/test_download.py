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
 def test_existing_tool_skips_network_with_same_search_path(self):
  receipts=[]
  with patch.object(m.shutil,'which',return_value='/usr/local/bin/automake') as which,patch.object(m,'download') as download:
   m.prepare_automake(pathlib.Path('/unused'),'exact-search-path',receipts.append)
   which.assert_called_once_with('automake',path='exact-search-path');download.assert_not_called()
  self.assertEqual(receipts,[{'input':'automake-source','outcome':'not-needed-tool-present'}])
 def test_primary_connection_failure_uses_only_pinned_mirror(self):
  receipts=[];verified={'file':'automake-1.18.1.tar.xz','bytes':1652392,'sha256':m.AUTOMAKE_SHA}
  with patch.object(m.shutil,'which',return_value=None),patch.object(m,'download',side_effect=[m.DownloadConnectionError(),verified]) as download:
   m.prepare_automake(pathlib.Path('/unused'),'path',receipts.append)
   self.assertEqual([call.args[0] for call in download.call_args_list],list(m.AUTOMAKE_URLS))
   self.assertTrue(all(call.args[2:]==(m.AUTOMAKE_SHA,8*1024**2) for call in download.call_args_list))
  self.assertEqual([r['outcome'] for r in receipts],['connection-failed','verified'])
 def test_hash_failure_never_uses_mirror(self):
  receipts=[]
  with patch.object(m.shutil,'which',return_value=None),patch.object(m,'download',side_effect=AssertionError('Download hash')) as download:
   with self.assertRaisesRegex(AssertionError,'hash'):m.prepare_automake(pathlib.Path('/unused'),'path',receipts.append)
   self.assertEqual(download.call_count,1)
  self.assertEqual(receipts[0]['outcome'],'failed')
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
