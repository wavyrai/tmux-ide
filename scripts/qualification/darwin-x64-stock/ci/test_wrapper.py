import pathlib,sys,importlib.util,unittest,tempfile,json
from unittest.mock import patch
HERE=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
spec=importlib.util.spec_from_file_location('stock_wrapper',HERE/'prepare.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Wrapper(unittest.TestCase):
 def test_held_wrapper_refuses_before_intake_or_output_creation(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);(root/'stock-pins.json').write_text(json.dumps({'executionAuthorized':False}))
   argv=['wrapper','--metadata','missing','--archive','missing','--reference-recipe','missing','--output',str(root/'output')]
   with patch.object(m,'RECIPE',root),patch.object(m.platform,'system',return_value='Darwin'),patch.object(m.platform,'machine',return_value='x86_64'),patch.object(sys,'argv',argv),patch.object(m,'intake') as intake:
    with self.assertRaisesRegex(AssertionError,'not authorized'):m.main()
    intake.assert_not_called()
   self.assertFalse((root/'output').exists())
if __name__=='__main__':unittest.main()
