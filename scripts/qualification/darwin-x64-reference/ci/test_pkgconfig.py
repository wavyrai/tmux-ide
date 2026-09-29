import importlib.util,pathlib,tempfile,unittest,sys,json,stat
RECIPE=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(RECIPE))
spec=importlib.util.spec_from_file_location('reference_build',RECIPE/'build-reference.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class PkgConfig(unittest.TestCase):
 def test_actual_bottle_read_only_metadata_rewrite_only_mutates_private_pc(self):
  fixture=json.loads((RECIPE/'ci/pkgconfig-fixture.json').read_text());self.assertEqual(fixture['mode'],0o444)
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);pc=root/fixture['member'];pc.parent.mkdir(parents=True);pc.write_text(fixture['text']);pc.chmod(fixture['mode']);self.assertEqual(m.sha(pc),fixture['sha256'])
   keg=root/'utf8proc/2.11.3';header=keg/'include/untouched.h';header.parent.mkdir();header.write_text('header');header.chmod(0o444)
   alias=pc.parent/'alias.pc';alias.symlink_to(pc.name)
   m.rewrite_pkgconfig(keg)
   self.assertEqual(pc.read_text(),fixture['text'].replace('@@HOMEBREW_CELLAR@@',str(root)))
   self.assertEqual(stat.S_IMODE(pc.stat().st_mode),0o644);self.assertEqual(stat.S_IMODE(header.stat().st_mode),0o444)
   self.assertEqual(header.read_text(),'header');self.assertTrue(alias.is_symlink())
if __name__=='__main__':unittest.main()
