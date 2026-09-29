import sys,pathlib,tempfile,tarfile,py_compile,subprocess,hashlib,os,unittest
R=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(R))
from extract_runtime import extract_runtime
from overlay_times import restore_overlay_times
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
class Cache(unittest.TestCase):
 def test_actual_interpreter_cache_survives_only_timestamp_restoration(self):
  with tempfile.TemporaryDirectory() as d:
   d=pathlib.Path(d);src=d/'source';src.mkdir();p=src/'owned_fixture.py';p.write_text('VALUE = 42\n');os.utime(p,(1000000000,1000000000));cache=pathlib.Path(py_compile.compile(str(p),doraise=True));rel=cache.relative_to(src);original=sha(cache);archive=d/'overlay.tar'
   with tarfile.open(archive,'w') as tf:tf.add(src,arcname='.')
   for restored in [False,True]:
    out=d/str(restored);extract_runtime(archive,out)
    if restored:restore_overlay_times(archive,out)
    subprocess.run([sys.executable,'-c','import owned_fixture; assert owned_fixture.VALUE == 42'],cwd=out,env={'PATH':'/usr/bin:/bin'},check=True,timeout=5)
    self.assertEqual(sha(out/rel)==original,restored)
 def test_links_refused(self):
  with tempfile.TemporaryDirectory() as d:
   d=pathlib.Path(d);archive=d/'overlay.tar';target=d/'out';target.mkdir()
   with tarfile.open(archive,'w') as tf:
    m=tarfile.TarInfo('link');m.type=tarfile.SYMTYPE;m.linkname='outside';tf.addfile(m)
   with self.assertRaises(AssertionError):restore_overlay_times(archive,target)
if __name__=='__main__':unittest.main()
