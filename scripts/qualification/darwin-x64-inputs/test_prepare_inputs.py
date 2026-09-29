import io, pathlib, tarfile, tempfile, unittest
import importlib.util
spec=importlib.util.spec_from_file_location('prepare_inputs',pathlib.Path(__file__).with_name('prepare-inputs.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
unpack_tar=module.unpack_tar
from package_payload import package_payload
class ExtractTests(unittest.TestCase):
    def archive(self, root, members):
        p=root/'input.tar'
        with tarfile.open(p,'w') as tar:
            for name, target in members:
                info=tarfile.TarInfo(name)
                if target is None:
                    info.size=4;tar.addfile(info,io.BytesIO(b'data'))
                else:
                    info.type=tarfile.SYMTYPE;info.linkname=target;tar.addfile(info)
        return p
    def test_internal_link_keeps_exact_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=pathlib.Path(tmp);unpack_tar(self.archive(r,[('package/tool',None),('package/link','tool')]),r/'out')
            self.assertEqual((r/'out/package/link').read_bytes(),b'data')
    def test_escaping_path_or_link_refused(self):
        for name,target in [('../outside',None),('package/link','../../outside')]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as tmp:
                r=pathlib.Path(tmp)
                with self.assertRaises(AssertionError):unpack_tar(self.archive(r,[(name,target)]),r/'out')
                self.assertFalse((r/'outside').exists())
    def test_payload_roundtrip_preserves_modes_internal_links_and_bundled_tool_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=pathlib.Path(tmp);(r/'tmp').mkdir();(r/'tools/pnpm/dist/node_modules').mkdir(parents=True)
            tool=r/'tools/pnpm/tool';tool.write_bytes(b'tool');tool.chmod(0o755)
            (r/'tools/pnpm/dist/node_modules/dependency').write_bytes(b'vendor')
            (r/'bin').mkdir();(r/'bin/pnpm').symlink_to(tool)
            (r/'source/node_modules').mkdir(parents=True);(r/'source/node_modules/redundant').write_bytes(b'omit')
            receipt=package_payload(r,unpack_tar)
            self.assertTrue(receipt['roundtripVerified'])
            self.assertEqual(receipt['members']['tools/pnpm/tool']['mode'],0o755)
            self.assertEqual(receipt['members']['bin/pnpm']['target'],'../tools/pnpm/tool')
            self.assertIn('tools/pnpm/dist/node_modules/dependency',receipt['members'])
            self.assertNotIn('source/node_modules',receipt['members'])
    def test_duplicate_entry_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            r=pathlib.Path(tmp)
            with self.assertRaises(AssertionError):unpack_tar(self.archive(r,[('package/a',None),('package/a',None)]),r/'out')
if __name__=='__main__':unittest.main()
