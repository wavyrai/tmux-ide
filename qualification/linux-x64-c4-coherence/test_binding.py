import unittest,copy,json,pathlib
from fresh_process_host import bind,require_reviewed_pins,require_closed_campaign
class Binding(unittest.TestCase):
 def fixture(self):
  receipt={'processHost':{'bootId':'old-build-boot'},'tools':{'/usr/bin/getconf':{'sha256':'a'*64}}}
  observed={'platform':'linux','arch':'x64','bootId':'12345678-1234-1234-1234-123456789abc','clockTicksPerSecond':100,'getconf':{'path':'/usr/bin/getconf','sha256':'a'*64}}
  return receipt,observed
 def test_new_boot_does_not_rewrite_archive(self):
  r,o=self.fixture();old=copy.deepcopy(r);v=bind(r,o,'b'*64);self.assertEqual(r,old);self.assertEqual(v['processHost']['bootId'],o['bootId']);self.assertEqual(v['archivedProcessHost'],r['processHost']);v['archivedProcessHost']['bootId']='mutated';self.assertEqual(r,old)
 def test_bad_identity_or_tool_refused(self):
  for key,val in [('arch','arm64'),('platform','darwin'),('bootId','bad'),('clockTicksPerSecond',0),('clockTicksPerSecond',True),('getconf',{'path':'/bin/getconf','sha256':'a'*64}),('getconf',{'path':'/usr/bin/getconf','sha256':'b'*64})]:
   r,o=self.fixture();o[key]=val
   with self.assertRaises(AssertionError):bind(r,o,'b'*64)
 def test_draft_pins_cannot_execute(self):
  d=json.loads((pathlib.Path(__file__).parent/'pins.json').read_text())
  with self.assertRaises(AssertionError):require_reviewed_pins(d)
  with self.assertRaises(AssertionError):require_closed_campaign(d)
  d['reviewed']=True
  with self.assertRaises(AssertionError):require_reviewed_pins(d)
  with self.assertRaises(AssertionError):require_closed_campaign(d)
if __name__=='__main__':unittest.main()
