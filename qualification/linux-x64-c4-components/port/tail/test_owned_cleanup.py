import unittest
from unittest.mock import patch
import linux_process
from owned_cleanup import cleanup_owned
class CleanupTests(unittest.TestCase):
 def setUp(self):
  p=patch.object(linux_process,"assert_live",return_value={});p.start();self.addCleanup(p.stop)
 def test_exact_witness_kills(self):
  calls=[]
  def run(*args):calls.append(args);return '42\t100' if args[0]=='display-message' else ''
  rows=cleanup_owned(None,run,'42','100','/private')
  self.assertEqual(calls[-1],('kill-server',));self.assertFalse(any('error' in x for x in rows))
 def test_replacement_refuses(self):
  calls=[]
  def run(*args):calls.append(args);return '43\t100'
  rows=cleanup_owned(None,run,'42','100','/private')
  self.assertEqual(len(calls),1);self.assertIn('error',rows[-1])
 def test_missing_identity_refuses(self):
  rows=cleanup_owned(None,lambda *args:self.fail('must not call'),None,None,'/private')
  self.assertIn('error',rows[-1])
unittest.main()
