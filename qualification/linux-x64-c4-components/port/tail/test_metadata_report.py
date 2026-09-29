import unittest
from metadata_report import distribution
class ReportTests(unittest.TestCase):
 def test_command_only_nearest_rank(self):
  values=[{'kind':1,'milliseconds':i} for i in range(1,101)]+[{'kind':5,'milliseconds':10000}]
  result=distribution(values);self.assertEqual(result['commands'],100);self.assertEqual(result['p99Ms'],99);self.assertFalse(result['passed'])
 def test_boundaries(self):
  self.assertTrue(distribution([{'kind':1,'milliseconds':50}]*99+[{'kind':1,'milliseconds':100}])['passed'])
  self.assertFalse(distribution([{'kind':1,'milliseconds':50}]*99+[{'kind':1,'milliseconds':100.001}])['passed'])
  with self.assertRaises(ValueError):distribution([{'kind':1,'milliseconds':-1}])
if __name__=='__main__':unittest.main()
