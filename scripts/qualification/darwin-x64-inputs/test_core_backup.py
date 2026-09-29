import pathlib,tempfile,unittest
from core_backup import CoreBackup,witness
class BackupTests(unittest.TestCase):
    def test_original_entire_tree_restored_and_new_checkout_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);core=root/'core';core.mkdir();(core/'custom').write_bytes(b'original')
            original=witness(core);saved=[];backup=CoreBackup(core,root/'backup',lambda value:saved.append(dict(value)))
            backup.preserve();core.mkdir();(core/'new').write_bytes(b'qualified');backup.admit_replacement();backup.restore()
            self.assertEqual(witness(core),original);self.assertEqual((core/'custom').read_bytes(),b'original')
            self.assertEqual((root/'backup/replacement/new').read_bytes(),b'qualified');self.assertTrue(saved[-1]['restored'])
    def test_absent_failed_tap_restores_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);core=root/'core';core.mkdir();original=witness(core)
            backup=CoreBackup(core,root/'backup',lambda value:None);backup.preserve();backup.restore()
            self.assertEqual(witness(core),original)
    def test_unknown_partial_tap_retained_without_overwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);core=root/'core';core.mkdir();backup=CoreBackup(core,root/'backup',lambda value:None)
            backup.preserve();core.mkdir();(core/'unknown').write_text('retain')
            with self.assertRaises(AssertionError):backup.restore()
            self.assertTrue((core/'unknown').exists());self.assertTrue((root/'backup/original').is_dir())
    def test_replaced_directory_refuses_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);core=root/'core';core.mkdir();backup=CoreBackup(core,root/'backup',lambda value:None)
            backup.preserve();core.mkdir();backup.admit_replacement();core.rename(root/'other');core.mkdir()
            with self.assertRaises(AssertionError):backup.restore()
            self.assertTrue((root/'backup/original').exists())
if __name__=='__main__':unittest.main()
