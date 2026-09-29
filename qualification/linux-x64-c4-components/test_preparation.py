"""Pure source/closure checks. No build, imports of native modules or live fixture."""
import ast,hashlib,json,pathlib,tempfile,unittest
from closure import verify
Q=pathlib.Path(__file__).parent
class PreparationTest(unittest.TestCase):
 def test_port_pins_and_only_four_component_changes(self):
  d=json.loads((Q/'pins.json').read_text());actual={n:hashlib.sha256((Q/'port'/n).read_bytes()).hexdigest() for n in d['portFiles']};self.assertEqual(actual,d['portFiles'])
  changed={n for n in actual if actual[n]!=d['originalPortFiles'][n]};self.assertEqual(changed,{'common/host-descriptor.mjs','common/linux-host.mjs','common/linux-owned.mjs','common/proc-bridge.mjs'})
  self.assertEqual(len(d['matchingReaderInputs']),132);self.assertTrue(all(r['armPreparedSha256']==r['x64PreparedSha256'] for r in d['matchingReaderInputs']))
 def test_closed_import_and_build_scope(self):
  s=(Q/'import-components.mjs').read_text();self.assertIn("process.arch,'x64'",s);self.assertIn('/linux-x64/pty.node',s);self.assertIn("require('@xterm/headless-stock')",s);self.assertLess(s.index('await linuxHost(freshHost).assertIdentity()'),s.index("require('node-pty')"));self.assertIn('base.hostArtifactSha256',s)
  s=(Q/'build-components.mjs').read_text();self.assertIn("['metadata','tail','parser']",s);self.assertIn("cliBundlePlugins()",s);self.assertNotIn('build-cli',s)
  s=(Q/'prepare-components.py').read_text();self.assertIn("D['preparationOnly'] is True",s);self.assertIn('restore_overlay_times(archive,roundtrip)',s);self.assertNotIn('approved-campaign',s)
 def test_stale_host_not_mutated(self):
  for n in ['linux-owned.mjs','proc-bridge.mjs']:self.assertIn('/evidence/component-host.json',(Q/'port/common'/n).read_text())
  self.assertIn("read('/proc/self/cgroup')",(Q/'port/common/linux-host.mjs').read_text())
  self.assertNotIn("(W/'host.json').write_text",(Q/'prepare-components.py').read_text())
 def test_all_python_source_parses(self):
  for p in Q.rglob('*.py'):ast.parse(p.read_text(),str(p))
 def test_only_component_subtree_may_extend_original_closure(self):
  with tempfile.TemporaryDirectory() as temp:
   w=pathlib.Path(temp);rows=[]
   for name in ['source','native','native-grid-reference']:
    p=w/name;p.mkdir(mode=0o700);rows.append({'path':'/work/'+name,'mode':0o700,'kind':'directory'})
   for name in ['host.json','host-inputs.json','artifact-receipt.json']:
    p=w/name;p.write_bytes(b'{}');p.chmod(0o600);rows.append({'path':'/work/'+name,'mode':0o600,'kind':'file','bytes':2,'sha256':hashlib.sha256(b'{}').hexdigest()})
   tasks=w/'source/.tasks';tasks.mkdir(mode=0o700);rows.append({'path':'/work/source/.tasks','mode':0o700,'kind':'directory'})
   component=tasks/'components-linux';component.mkdir();(component/'new').write_text('prepared')
   self.assertEqual(verify(w,{'rows':rows},allow_component=True)['entries'],7)
   (w/'source/product-change').write_text('bad')
   with self.assertRaises(AssertionError):verify(w,{'rows':rows},allow_component=True)
if __name__=='__main__':unittest.main()
