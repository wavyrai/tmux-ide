import unittest,pathlib,tempfile,json,types,importlib.util
from unittest.mock import patch
BASE=pathlib.Path(__file__).resolve().parent
class IntegrationTests(unittest.TestCase):
 def test_failed_prerequisite_preserves_receipts_and_never_freezes_or_launches_cpu(self):
  spec=importlib.util.spec_from_file_location('reviewed_runner',BASE/'runner.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);recipe=root/'recipe';recipe.mkdir();pins=json.loads((BASE/'pins.json').read_text());pins['executionAuthorized']=True;(recipe/'pins.json').write_text(json.dumps(pins));(recipe/'recipe-files.json').write_text(json.dumps({'pins.json':runner.sha(recipe/'pins.json')}));output=root/'attempt';calls=[];order=[]
   def download(p,d):d.mkdir();return d/'fake.zip'
   def intake(z,p,d):d.mkdir();payload=d/'payload';payload.mkdir();return payload
   def prerequisite(binding,admission,base,d):
    order.append('reference');d.mkdir();(d/'terminal.json').write_text(json.dumps({'exit':1,'cleanupExit':0,'postclosure':True}));raise RuntimeError('Retained functional failure')
   def host(argv,**kwargs):
    order.append('host');pathlib.Path(argv[-1]).write_text(json.dumps({'platform':'darwin','arch':'x64','boot':'fixture-only'}))
   def module(name,path):
    calls.append(name)
    if name=='cpu_intake':return types.SimpleNamespace(intake=intake)
    if name=='reference_prerequisite':return types.SimpleNamespace(run=prerequisite)
    raise AssertionError('CPU freeze/run must not follow failed prerequisite: '+name)
   with patch.object(runner,'BASE',recipe),patch.object(runner,'download',download),patch.object(runner,'module',module),patch.object(runner,'bind_runtime',return_value={'paths':{'node':'/fake/not-executed'}}),patch.object(runner.subprocess,'run',side_effect=host),patch.object(runner,'stage_sources') as stage:
    with self.assertRaisesRegex(RuntimeError,'Retained functional failure'):runner.run(output)
    stage.assert_not_called()
   self.assertEqual(calls,['cpu_intake','reference_prerequisite']);self.assertEqual(order,['host','reference'])
   self.assertEqual(json.loads((output/'evidence/reference-host.json').read_text())['arch'],'x64')
   self.assertFalse(json.loads((output/'evidence/status.json').read_text())['ok'])
   self.assertEqual(json.loads((output/'evidence/reference-functional/terminal.json').read_text())['cleanupExit'],0)
if __name__=='__main__':unittest.main()
