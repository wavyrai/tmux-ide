import unittest
from cpu_accounting import total_cpu
class Accounting(unittest.TestCase):
 def fixture(self):
  s=lambda pid,cpu:dict(platform='linux',pid=pid,startIdentity='linux:boot:'+str(pid)+':123',cpuSeconds=cpu,status='present',alive=True)
  return dict(fixtureSelfCpuSeconds=1,serverSample=s(10,2),orphanAppSample=s(11,.5),serverCpuSeconds=2,orphanAppCpuSeconds=.5,reapedIdentities=['daemon'],accountingOwnership=dict(fixturePid=20,daemonPid=21,daemonParent=20,serverParent=1,appParent=10,containerInit=True))
 def test_actual_orphan_partition_required(self):
  self.assertEqual(total_cpu(4,self.fixture()),5.5)
  for key,value in [('serverParent',20),('appParent',20),('daemonParent',1),('containerInit',False)]:
   data=self.fixture();data['accountingOwnership'][key]=value
   with self.assertRaises(AssertionError):total_cpu(4,data)
 def test_overlap_and_missing_samples_fail(self):
  data=self.fixture();data['reapedIdentities']=[data['serverSample']['startIdentity']]
  with self.assertRaises(AssertionError):total_cpu(4,data)
if __name__=='__main__':unittest.main()
