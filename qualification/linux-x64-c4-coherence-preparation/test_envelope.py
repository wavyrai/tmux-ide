import ast,json,hashlib,pathlib,unittest
Q=pathlib.Path(__file__).parent
class Envelope(unittest.TestCase):
 def test_closed_original_drivers_and_port(self):
  d=json.loads((Q/'pins.json').read_text())
  self.assertEqual({str(p.relative_to(Q/'port')):hashlib.sha256(p.read_bytes()).hexdigest() for p in (Q/'port').rglob('*') if p.is_file()},d['portFiles'])
  self.assertEqual(d['source']['commit'],'be8bcfad29610265716b8dcb657658cf8f1d0ba3');self.assertTrue(d['preparationOnly'])
 def test_actual_docker_log_argv(self):
  tree=ast.parse((Q/'launch.py').read_text());calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='call' and n.args and isinstance(n.args[0],ast.List) and n.args[0].elts and isinstance(n.args[0].elts[0],ast.Constant) and n.args[0].elts[0].value=='logs'];self.assertEqual(len(calls),1)
  expr=ast.Expression(calls[0].args[0]);ast.fix_missing_locations(expr);self.assertEqual(eval(compile(expr,'argv','eval'),{'__builtins__':{}},{'cid':'owned'}),['logs','--tail','100','owned'])
 def test_build_source_closed_no_fixture_or_native_rebuild(self):
  s=(Q/'prepare-coherence.py').read_text();self.assertNotIn('build-bundled-tmux',s);self.assertNotIn("coherence-canonical.ts'",s);self.assertIn("['cli-build'",s.replace("run('cli-build'","['cli-build'"))
  self.assertIn("assert os.getuid()>0",s);self.assertIn("'/work/runtime-extracted'",s);self.assertIn("verify('/work',ledger)",s);self.assertIn("p.suffix not in ['.tar','.gz','.bundle']",s)
  for p in Q.glob('*.py'):ast.parse(p.read_text(),str(p))
if __name__=='__main__':unittest.main()
