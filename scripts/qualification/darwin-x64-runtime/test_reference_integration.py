import unittest,pathlib,tempfile,json,types,importlib.util
from unittest.mock import patch
BASE=pathlib.Path(__file__).resolve().parent
class IntegrationTests(unittest.TestCase):
 def test_socket_evidence_is_recorded_without_copy_or_retirement_claim(self):
  import socket
  spec=importlib.util.spec_from_file_location('collector_runner',BASE/'runner.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);source=root/'s';source.mkdir();(source/'receipts').mkdir();(source/'receipts/owner.json').write_text('{"cleanup":{"retired":true}}');(source/'temp').mkdir();(source/'temp/paint.cjs').write_text('fixture');(source/'terminal.json').write_text('{"postclosure":false}')
   endpoint=source/'temp/s';sock=socket.socket(socket.AF_UNIX);sock.bind(str(endpoint))
   try:
    runner.collect_reference_evidence(source,root/'out')
    self.assertTrue(endpoint.is_socket());self.assertFalse((root/'out/temp/s').exists())
    self.assertEqual((root/'out/receipts/owner.json').read_bytes(),(source/'receipts/owner.json').read_bytes())
    self.assertEqual((root/'out/temp/paint.cjs').read_text(),'fixture')
    self.assertFalse(json.loads((root/'out/terminal.json').read_text())['postclosure'])
    receipt=json.loads((root/'out/collection-diagnostics.json').read_text());self.assertEqual([(x['path'],x['type']) for x in receipt['skippedSpecialPaths']],[('temp/s','socket')]);self.assertFalse(receipt['cleanupInferred']);self.assertFalse(receipt['sourcePathsDeleted'])
   finally:sock.close()
 def test_reviewed_receipt_precedes_transport_and_derivation_is_sealed_before_freeze(self):
  spec=importlib.util.spec_from_file_location('reviewed_runner',BASE/'runner.py');runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);recipe=root/'recipe';recipe.mkdir();pins=json.loads((BASE/'pins.json').read_text());pins['executionAuthorized']=True;(recipe/'pins.json').write_text(json.dumps(pins));(recipe/'recipe-files.json').write_text(json.dumps({'pins.json':runner.sha(recipe/'pins.json')}));(recipe/'reference-functional-accepted.json').write_bytes((BASE/'reference-functional-accepted.json').read_bytes());output=root/'attempt';order=[];sealed={}
   prerequisite=runner.module('actual_prerequisite',BASE/'reference-prerequisite.py')
   def download(p,d):order.append('download');d.mkdir();return d/'fake.zip'
   def intake(z,p,d):d.mkdir();payload=d/'payload';payload.mkdir();return payload
   def derive(admission,d,verifier):
    order.append('derive');d.mkdir();receipt=d/'derivation.json';ledger=d/'derived-ledger.json';receipt.write_text('{}');ledger.write_text('{}');sealed.update(receipt=str(receipt),receiptSha256=runner.sha(receipt),ledger=str(ledger),ledgerSha256=runner.sha(ledger));return dict(sealed)
   def bind(*args):
    order.append('bind');self.assertEqual(args[-1],sealed);return {'paths':{'node':'/fake/not-executed'},'dependencyModeDerivation':dict(sealed)}
   def stage(binding,d):order.append('stage');d.mkdir()
   def freeze(binding,admission,overlay,d):
    order.append('freeze');self.assertEqual(json.loads(pathlib.Path(admission).read_text())['dependencyModeDerivation'],sealed);self.assertEqual(json.loads(pathlib.Path(binding).read_text())['referenceFunctional']['originRunId'],36680179337);d.mkdir();(d/'frozen-cpu.json').write_text('{}')
   def module(name,path):
    if name=='reference_prerequisite':order.append('receipt');return prerequisite
    if name=='cpu_intake':return types.SimpleNamespace(intake=intake)
    if name=='derived_runtime':return types.SimpleNamespace(prepare=derive)
    if name=='cpu_freeze':return types.SimpleNamespace(freeze=freeze)
    if name=='cpu_run':return types.SimpleNamespace(run=lambda *args:order.append('run'))
    raise AssertionError('Unexpected module or live reference rerun: '+name)
   with patch.object(runner,'BASE',recipe),patch.object(runner,'download',download),patch.object(runner,'module',module),patch.object(runner,'bind_runtime',side_effect=bind),patch.object(runner,'stage_sources',side_effect=stage),patch.object(runner.subprocess,'run') as process:
    runner.run(output);process.assert_not_called()
   self.assertEqual(order,['receipt','download','download','derive','bind','stage','freeze','run']);self.assertTrue((output/'evidence/runtime-derivation/derivation.json').exists());self.assertTrue((output/'evidence/reference-functional-accepted.json').exists())
   # A changed prerequisite is refused before any transport, derivation or runtime call.
   (recipe/'reference-functional-accepted.json').write_text('{}')
   with patch.object(runner,'BASE',recipe),patch.object(runner,'module',module),patch.object(runner,'download') as transport:
    with self.assertRaisesRegex(AssertionError,'receipt changed'):runner.run(root/'rejected')
    transport.assert_not_called()
if __name__=='__main__':unittest.main()
