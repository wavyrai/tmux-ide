"""Pure filesystem/source regressions; never invoke Docker, product or campaign."""
import ast,hashlib,json,pathlib,tempfile,unittest
from cpu_environment import snapshot
from closure import verify
P=pathlib.Path
class CampaignSourceTest(unittest.TestCase):
 def cgroups(self,root):
  for p in [root,root/'system.slice',root/'system.slice/owned.scope']:
   p.mkdir(parents=True,exist_ok=True)
   (p/'cpu.stat').write_text('nr_throttled 0\nthrottled_usec 0\n')
   if p!=root:(p/'cpu.max').write_text('max 100000\n')
 def test_actual_container_and_ancestors_not_mount_root(self):
  with tempfile.TemporaryDirectory() as temp:
   root=P(temp);self.cgroups(root)
   result=snapshot(root,'0::/system.slice/owned.scope')
   self.assertEqual([r['path'] for r in result['ancestors']],[str(root/'system.slice/owned.scope'),str(root/'system.slice'),str(root)])
   (root/'system.slice/owned.scope/cpu.stat').write_text('nr_throttled 1\nthrottled_usec 45\n')
   self.assertNotEqual(result,snapshot(root,'0::/system.slice/owned.scope'))
 def test_parent_quota_and_missing_controller_rejected(self):
  with tempfile.TemporaryDirectory() as temp:
   root=P(temp);self.cgroups(root);p=root/'system.slice/cpu.max';p.write_text('100000 100000')
   with self.assertRaises(AssertionError):snapshot(root,'0::/system.slice/owned.scope')
   p.unlink()
   with self.assertRaises(AssertionError):snapshot(root,'0::/system.slice/owned.scope')
 def test_malformed_identity_rejected(self):
  for raw in ['0::/../escape','1:name=x:/','0::/scope\n1:cpu:/scope']:
   with self.assertRaises(AssertionError):snapshot(P('/unused'),raw)
 def test_closed_source_pins_and_unchanged_campaign_budget(self):
  q=P(__file__).parent;d=json.loads((q/'pins.json').read_text());h=q.parent/'linux-x64-c4-cli/harness'
  for n,sha in d['harnessFiles'].items():self.assertEqual(hashlib.sha256((h/n).read_bytes()).hexdigest(),sha)
  s=(h/'campaign.py').read_text();self.assertIn("all(x<=10 for x in deltas.values())",s);self.assertIn("total_cpu(row['fixtureInclusiveCpuSeconds'],data)",s)
  for p in q.glob('*.py'):ast.parse(p.read_text(),str(p))
 def test_manifest_fix_retains_nested_ledger(self):
  s=(P(__file__).parent/'cleanup.py').read_text();self.assertIn("p!=E/'artifact-hashes.json'",s)
 def test_closure_detects_changed_bytes_modes_and_extra_files(self):
  with tempfile.TemporaryDirectory() as temp:
   w=P(temp);rows=[]
   for name in ['source','native','native-grid-reference']:
    p=w/name;p.mkdir(mode=0o700);rows.append({'path':'/work/'+name,'mode':0o700,'kind':'directory'})
   for name in ['host.json','host-inputs.json','artifact-receipt.json']:
    p=w/name;p.write_bytes(b'{}');p.chmod(0o600);rows.append({'path':'/work/'+name,'mode':0o600,'kind':'file','bytes':2,'sha256':hashlib.sha256(b'{}').hexdigest()})
   ledger={'rows':rows};self.assertEqual(verify(w,ledger)['entries'],6)
   p=w/'host.json';p.write_bytes(b'[]')
   with self.assertRaises(AssertionError):verify(w,ledger)
   p.write_bytes(b'{}');p.chmod(0o644)
   with self.assertRaises(AssertionError):verify(w,ledger)
   p.chmod(0o600);(w/'source/extra').write_text('unexpected')
   with self.assertRaises(AssertionError):verify(w,ledger)
if __name__=='__main__':unittest.main()
