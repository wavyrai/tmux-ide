import pathlib,tempfile,unittest,os,json
from prepare import prepare
HERE=pathlib.Path(__file__).resolve().parent
class Tests(unittest.TestCase):
 def test_existing_four_case_bodies_and_external_paths_preserved(self):
  source=pathlib.Path(os.environ['TMUX_QUAL_SOURCE']).resolve()
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);ref=root/'reference';ref.write_text('source-fixture-not-executed');out=root/'overlay'
   receipt=prepare({'paths':{'source':str(source),'reference':str(ref)}},out)
   original=(source/'packages/daemon/src/terminal/mirror/native-frozen-grid-live.test.ts').read_text();staged=(out/'reference-grid-live.test.ts').read_text()
   for first,last in [('  it.each([','])('),('      let retained = capture();','    } finally {')]:
    self.assertEqual(original[original.index(first):original.index(last,original.index(first))],staged[staged.index(first):staged.index(last,staged.index(first))])
   self.assertIn('await owner.cleanup()',staged);self.assertNotIn('spawnSync(executable!',staged)
   config=json.loads((out/'vitest.config.mjs').read_text().removeprefix('export default ').removesuffix(';\n'))
   self.assertEqual(config['cacheDir'],str(out.resolve()/'cache'));self.assertEqual(config['root'],str(out.resolve()))
   self.assertEqual(receipt['expectedTests'],4);self.assertFalse(receipt['executionAuthorized'])
   helper=(out/'reference-owner.mjs').read_text();self.assertIn('fenceNativeTmuxCommand',helper);self.assertIn("['-N','kill-server']",helper);self.assertNotIn('__REFERENCE__',helper)
   self.assertEqual((out/'process-cpu.mjs').read_bytes(),(HERE/'process-cpu.mjs').read_bytes())
if __name__=='__main__':unittest.main()
