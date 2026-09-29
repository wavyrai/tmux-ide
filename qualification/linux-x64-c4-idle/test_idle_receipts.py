import copy,hashlib,json,pathlib,tempfile,unittest
from validate_idle import validate
P=pathlib.Path
class IdleReceiptTest(unittest.TestCase):
 def write(self,root):
  results=root/'results-idle';results.mkdir();(results/'verified-at-end.json').write_text('{}')
  for n in [1,2]:(root/f'cpu-environment-{n}.json').write_text(json.dumps({'topology':{'affinity':[0,2],'passed':True}}))
  case={'error':None,'cleanup':[{'ownedProcessesAbsent':True}],'count':2,'counts':{'pairs':2,'externalEffects':4,'backgroundEvidence':2,'totalEvidence':6},'evidence':[{} for _ in range(6)],'status':{'cursor':{'sequence':'12'}},'idleSeconds':125.01,'idleSamples':[{'status':{'cursor':{'sequence':'6'}}} for _ in range(26)],'elapsedSeconds':.04,'trace':{'producerStarts':1,'idleAttempts':[]}}
  row={'mode':'candidate32','round':1,'exit':0,'timeout':False,'terminalKnown':True,'cgroupThrottling':{'before':{},'after':{}},'case':case};return results/'results.json',row
 def test_original_idle_boundaries(self):
  with tempfile.TemporaryDirectory() as temp:
   root=P(temp);p,row=self.write(root);p.write_text(json.dumps([row]));self.assertTrue(validate(root)['idleReceiptPassed'])
   for key,value in [('idleSeconds',124.99),('elapsedSeconds',.100001),('evidence',[{}]*5),('idleSamples',[{'status':{}}]*25),('trace',{'producerStarts':2,'idleAttempts':[]})]:
    changed=copy.deepcopy(row);changed['case'][key]=value;p.write_text(json.dumps([changed]))
    with self.assertRaises(AssertionError,msg=key):validate(root)
 def test_cleanup_cursor_and_native_poll_cannot_pass(self):
  with tempfile.TemporaryDirectory() as temp:
   root=P(temp);p,row=self.write(root)
   for key,value in [('cleanup',[{'error':'retirement failed'}]),('status',{'cursor':{'sequence':'10'}}),('trace',{'producerStarts':1,'idleAttempts':[{'argv':['tmux-ide-events','read']}]} )]:
    changed=copy.deepcopy(row);changed['case'][key]=value;p.write_text(json.dumps([changed]))
    with self.assertRaises(AssertionError,msg=key):validate(root)
 def test_exact_accepted_overlay_hashes_and_original_retained(self):
  q=P(__file__).parent;d=json.loads((q/'pins.json').read_text())
  for name,sha in d['idleOverlay'].items():self.assertEqual(hashlib.sha256((q/name).read_bytes()).hexdigest(),sha)
  original=q.parent/'linux-x64-c4-cli/harness/case.mjs';self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(),d['harnessFiles']['case.mjs'])
  source=(q/'execute.py').read_text();self.assertIn("(H/'campaign-idle.py').write_text(source)",source);self.assertNotIn("(H/'case.mjs').write_text",source)
  self.assertIn("'idle','/evidence/frozen-spec.json','/evidence/results-idle'",source)
if __name__=='__main__':unittest.main()
