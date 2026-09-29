import importlib.util,pathlib,tempfile,unittest,sys,tarfile,io,os,json
RECIPE=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(RECIPE))
spec=importlib.util.spec_from_file_location('reference_build',RECIPE/'build-reference.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SourceTimes(unittest.TestCase):
 def test_original_distribution_order_survives_fresh_extraction(self):
  fixture=json.loads((RECIPE/'ci/automake-mtime-fixture.json').read_text())
  self.assertEqual(fixture['archiveSha256'],'168aa363278351b89af56684448f525a5bce5079d0b6842bd910fdd3f1646887')
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);archive=root/'source.tar';target=root/'extracted';target.mkdir()
   with tarfile.open(archive,'w') as t:
    for name,entry in fixture['files'].items():
     info=tarfile.TarInfo('automake-1.18.1/'+name);info.mtime=entry['mtime'];info.size=1;t.addfile(info,io.BytesIO(b'x'))
     path=target/info.name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'x');os.utime(path,(1800000000,1800000000))
   m.restore_source_mtimes(archive,target)
   times={name:(target/'automake-1.18.1'/name).stat().st_mtime for name in fixture['files']}
   self.assertEqual(times,{name:x['mtime'] for name,x in fixture['files'].items()})
   for generated,dependencies in {'m4/amversion.m4':['configure.ac','m4/amversion.in'],'aclocal.m4':['m4/amversion.m4'],'configure':['aclocal.m4','configure.ac'],'Makefile.in':['Makefile.am','configure.ac','aclocal.m4','t/testsuite-part.am'],'t/testsuite-part.am':['gen-testsuite-part','Makefile.am','t/list-of-tests.mk']}.items():
    self.assertGreaterEqual(times[generated],max(times[name] for name in dependencies),generated)
if __name__=='__main__':unittest.main()
