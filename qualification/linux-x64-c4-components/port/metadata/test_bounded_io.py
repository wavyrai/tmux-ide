import os,unittest
from unittest.mock import patch
import bounded_io as b
class BoundedTests(unittest.TestCase):
 def test_lines_and_timeout(self):
  r,w=os.pipe()
  try:
   with os.fdopen(r,'rb') as stream:
    os.write(w,b'one\ntwo\n');self.assertEqual(b.readline(stream),'one');self.assertEqual(b.readline(stream),'two')
    with self.assertRaises(TimeoutError):b.readline(stream,.001)
  finally:os.close(w)
 def test_eof(self):
  r,w=os.pipe();os.close(w)
  with os.fdopen(r,'rb') as stream:
   with self.assertRaises(EOFError):b.readline(stream)
 def test_wait4_bounds(self):
  with patch.object(b.os,'wait4',return_value=(0,0,None)):
   with self.assertRaises(TimeoutError):b.wait4(123,0)
  with patch.object(b.os,'wait4',return_value=(123,0,'usage')):self.assertEqual(b.wait4(123),(123,0,'usage'))
 def test_absence_never_assumed(self):
  with patch('linux_process.request',return_value=False):
   with self.assertRaises(TimeoutError):b.prove_absent([123],.001)
  with patch('linux_process.request',return_value=True):b.prove_absent([123],.001)
if __name__=='__main__':unittest.main()
