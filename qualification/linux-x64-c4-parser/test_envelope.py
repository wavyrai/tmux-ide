import ast,hashlib,json,pathlib,unittest
Q=pathlib.Path(__file__).parent
class Envelope(unittest.TestCase):
 def test_all_original_build_inputs_closed(self):
  d=json.loads((Q/'pins.json').read_text())
  for n,h in d['originalBuildInputs'].items():self.assertEqual(hashlib.sha256((Q/n).read_bytes()).hexdigest(),h)
  self.assertEqual(d['componentOverlay']['sha256'],'0718450c6823dfb590f88f8e313338c7f016cc73303ef57bfdc0346a3ac7061e');self.assertEqual(d['budgets']['retries'],0)
 def test_fresh_descriptor_freeze_and_no_build(self):
  s=(Q/'run-parser.py').read_text();self.assertIn("(E/'component-host.json').write_text",s);self.assertNotIn("(W/'host.json').write_text",s)
  self.assertLess(s.index("run('parser-import'"),s.index("run('preflight'"));self.assertLess(s.index("run('preflight'"),s.index("run('parser'"));self.assertNotIn("run('component-build'",s)
  freeze=(Q/'freeze-parser.mjs').read_text();self.assertIn("'/evidence/component-host.json'",freeze);self.assertIn('...component.closure',freeze)
 def test_source_parses_and_original_gate_unchanged(self):
  for p in Q.glob('*.py'):ast.parse(p.read_text(),str(p))
  self.assertIn("str(LANE/'echo.mjs'),'/work/native/tmux',str(E/'parser-results'),'qualification'],600",(Q/'run-parser.py').read_text())
 def test_accepted_oracle_bytes(self):
  expected={'parser_gate.py': 'b84af41c4c1faab6e05fa4187d747b48133a5f9b2021c2a5dc439b473e81a3d9', 'gate-parser.py': '4147b50231eba8785ca90630e286d6c3e1364595beba2cda3281b84bb88bb9c0'}
  for n,h in expected.items():self.assertEqual(hashlib.sha256((Q/n).read_bytes()).hexdigest(),h)
if __name__=='__main__':unittest.main()
