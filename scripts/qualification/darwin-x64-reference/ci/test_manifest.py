import importlib.util,pathlib,tempfile,unittest,sys
RECIPE=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(RECIPE))
spec=importlib.util.spec_from_file_location('reference_build',RECIPE/'build-reference.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Payload(unittest.TestCase):
 def test_real_home_file_missing_from_legacy_inventory_still_requires_manifest_bytes(self):
  relative='source/packages/daemon/src/tui/mirror/features/home/feature.test.ts'
  actual=RECIPE.parents[2]/relative.removeprefix('source/')
  expected='978aab7c7f78785c668fddf7cfd3131768d3de450a567b385710acb625e6cd6e'
  self.assertEqual(m.sha(actual),expected)
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);target=root/relative;target.parent.mkdir(parents=True);target.write_bytes(actual.read_bytes())
   manifest={relative:{'kind':'file','sha256':expected}}
   admitted,receipt=m.admit_payload_files(root,manifest,{'hashes':{}})
   self.assertEqual(admitted,{relative:expected});self.assertEqual(receipt['legacyNonoverlapPaths'],[relative]);self.assertEqual(receipt['legacyNonoverlapCount'],1)
   manifest[relative]['sha256']='0'*64
   with self.assertRaisesRegex(AssertionError,'Payload bytes mismatch'):m.admit_payload_files(root,manifest,{'hashes':{}})
if __name__=='__main__':unittest.main()
