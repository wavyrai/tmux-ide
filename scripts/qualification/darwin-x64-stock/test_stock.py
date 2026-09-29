import unittest,importlib.util,pathlib,tempfile,sys,json
from unittest.mock import patch
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('stock',HERE/'prepare-stock.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Stock(unittest.TestCase):
 def test_non_homebrew_candidate_is_ineligible_not_fatal(self):
  self.assertEqual(m.classify_host('tmux 3.7c',pathlib.Path('/usr/local/bin/custom-tmux')),'non-homebrew-path')
  self.assertEqual(m.classify_host('tmux 3.5a',pathlib.Path('/usr/local/Cellar/tmux/3.5a/bin/tmux')),'version')
  self.assertIsNone(m.classify_host('tmux 3.7c',pathlib.Path('/usr/local/Cellar/tmux/3.7c/bin/tmux')))
 def test_held_execution_refuses_before_any_output_mutation(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);(root/'stock-pins.json').write_text(json.dumps({'executionAuthorized':False}))
   argv=['stock']
   for name in ['inputs','upstream','assets','payload-manifest','reference-recipe']:argv.extend(['--'+name,'missing'])
   argv.extend(['--output',str(root/'output')])
   with patch.object(m,'HERE',root),patch.object(m.platform,'system',return_value='Darwin'),patch.object(m.platform,'machine',return_value='x86_64'),patch.object(sys,'argv',argv):
    with self.assertRaisesRegex(AssertionError,'not authorized'):m.main()
   self.assertFalse((root/'output').exists())
 def test_changed_input_receipt_refuses_before_helper_imports(self):
  with tempfile.TemporaryDirectory() as d:
   path=pathlib.Path(d)/'manifest';path.write_text('{}')
   with self.assertRaisesRegex(AssertionError,'Payload receipt mismatch'):m.admit({'executionAuthorized':True,'inputPayloadReceiptSha256':'0'*64},path,pathlib.Path('/unused'))
if __name__=='__main__':unittest.main()
