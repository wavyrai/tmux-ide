import unittest,tempfile,pathlib,subprocess,io,json,contextlib
from unittest.mock import patch
from runner import download
class Download(unittest.TestCase):
 def test_nonzero_is_preserved_once_with_bounded_diagnostic(self):
  error=subprocess.CalledProcessError(7,['gh','api'])
  def fail(*args,**kw):
   kw['stderr'].write(b'cause token123 https://private.invalid/?signature=secret\n'+b'x'*9000);kw['stderr'].flush();raise error
  with tempfile.TemporaryDirectory() as d,patch('runner.subprocess.run',side_effect=fail) as execute,patch.dict('os.environ',{'GH_TOKEN':'token123'}):
   output=io.StringIO()
   with contextlib.redirect_stdout(output),self.assertRaises(subprocess.CalledProcessError) as caught:download({'artifactId':12},pathlib.Path(d)/'out')
   self.assertIs(caught.exception,error);self.assertEqual(execute.call_count,1)
   value=json.loads(output.getvalue());self.assertEqual(value['exit'],7);self.assertTrue(value['truncated']);self.assertLessEqual(len(value['stderr']),8192)
   self.assertNotIn('token123',value['stderr']);self.assertNotIn('signature=secret',value['stderr']);self.assertIn('cause',value['stderr'])
 def test_failed_diagnostic_delivery_does_not_replace_original(self):
  error=subprocess.CalledProcessError(8,['gh','api'])
  with tempfile.TemporaryDirectory() as d,patch('runner.subprocess.run',side_effect=error) as execute,patch('builtins.print',side_effect=BrokenPipeError):
   with self.assertRaises(subprocess.CalledProcessError) as caught:download({'artifactId':12},pathlib.Path(d)/'out')
   self.assertIs(caught.exception,error);self.assertEqual(execute.call_count,1)
if __name__=='__main__':unittest.main()
