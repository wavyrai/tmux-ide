import os,stat,subprocess,tempfile,unittest
from pathlib import Path
from burst_source import PAIR,write_burst,bounded_failure
class BurstTests(unittest.TestCase):
 def test_exact_counts_mode_bounds_and_exclusive_creation(self):
  with tempfile.TemporaryDirectory() as d:
   for n in [1,256,471]:
    p=Path(d)/str(n);proof=write_burst(p,n);lines=p.read_text().splitlines()
    self.assertEqual(lines,['send-keys -t probe -l x','capture-pane -p -t probe']*n)
    self.assertEqual(proof['commands'],2*n);self.assertLessEqual(proof['bytes'],32768)
    self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o600)
    self.assertLess(sum(len(x)+1 for x in ['source-file',str(p)]),16380)
    with self.assertRaises(FileExistsError):write_burst(p,n)
 def test_invalid_sizes_and_symlink_refused(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'burst'
   for n in [0,472,-1,True,1.5]:
    with self.assertRaises(ValueError):write_burst(p,n)
   target=Path(d)/'target';target.write_text('keep');p.symlink_to(target)
   with self.assertRaises(OSError):write_burst(p,1)
   self.assertEqual(target.read_text(),'keep')
 def test_bounded_stderr_is_retained(self):
  error=subprocess.CalledProcessError(1,['tmux','source-file','private'],stderr=b'command too long\n'+b'x'*5000,output=b'partial')
  result=bounded_failure(error);self.assertEqual(result['returncode'],1);self.assertTrue(result['stderr'].startswith('command too long'))
  self.assertEqual(len(result['stderr']),2048);self.assertEqual(result['stdout'],'partial')
if __name__=='__main__':unittest.main()
