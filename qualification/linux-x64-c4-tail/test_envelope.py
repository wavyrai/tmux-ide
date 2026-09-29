import ast,hashlib,json,pathlib,unittest
Q=pathlib.Path(__file__).parent
class Envelope(unittest.TestCase):
 def test_all_original_build_inputs_closed(self):
  d=json.loads((Q/'pins.json').read_text())
  for n,h in d['originalBuildInputs'].items():self.assertEqual(hashlib.sha256((Q/n).read_bytes()).hexdigest(),h)
  self.assertEqual(d['componentOverlay']['sha256'],'0718450c6823dfb590f88f8e313338c7f016cc73303ef57bfdc0346a3ac7061e');self.assertEqual(d['budgets']['retries'],0)
 def test_fresh_descriptor_freeze_and_no_build(self):
  s=(Q/'run-tail.py').read_text();self.assertIn("(E/'component-host.json').write_text",s);self.assertNotIn("(W/'host.json').write_text",s)
  self.assertLess(s.index("run('cache-import'"),s.index("run('preflight'"));self.assertLess(s.index("run('preflight'"),s.index("run('tail'"));self.assertNotIn("run('component-build'",s)
  freeze=(Q/'freeze-tail.mjs').read_text();self.assertIn("'/evidence/component-host.json'",freeze);self.assertIn('...component.closure',freeze)
 def test_source_parses_and_original_gate_unchanged(self):
  for p in Q.glob('*.py'):ast.parse(p.read_text(),str(p))
  self.assertIn("'--approved-tail-backlog'",(Q/'run-tail.py').read_text());self.assertIn("timeout=300",(Q/'run-tail.py').read_text())
if __name__=='__main__':unittest.main()
