import pathlib,tempfile,unittest
from unittest.mock import patch
import brew_diagnostics as diagnostics
class DiagnosticTests(unittest.TestCase):
    def test_caps_tail_and_refuses_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);formula=root/'raw/openssl@3';formula.mkdir(parents=True)
            (formula/'postinstall.log').write_bytes(b'0123456789')
            (formula/'linked').symlink_to(formula/'postinstall.log')
            (root/'raw/libevent').symlink_to(formula,target_is_directory=True)
            with patch.multiple(diagnostics,FILE_CAP=4,TOTAL_CAP=8,COUNT_CAP=2):
                result=diagnostics.capture_logs(root/'raw',root/'copy')
            self.assertEqual(result['bytes'],4)
            self.assertEqual((root/'copy/00.log').read_bytes(),b'6789')
            self.assertTrue(result['files'][0]['truncated'])
            self.assertEqual({e['code'] for e in result['errors']},{'unsafe-or-unreadable-file','unsafe-directory'})
    def test_total_and_count_caps(self):
        for total,count,expected in [(5,9,5),(99,1,4)]:
            with tempfile.TemporaryDirectory() as tmp:
                root=pathlib.Path(tmp);formula=root/'raw/openssl@3';formula.mkdir(parents=True)
                for i in range(4):(formula/str(i)).write_bytes(b'12345678')
                with patch.multiple(diagnostics,FILE_CAP=4,TOTAL_CAP=total,COUNT_CAP=count):
                    result=diagnostics.capture_logs(root/'raw',root/'copy')
                self.assertEqual(result['bytes'],expected);self.assertLessEqual(len(result['files']),count)
    def test_failed_capture_and_save_preserve_original_exception(self):
        original=RuntimeError('original');captured=[]
        def fail():raise original
        def capture():captured.append(True);raise ValueError('capture')
        def save(status):raise OSError('save')
        with self.assertRaises(RuntimeError) as error:diagnostics.with_diagnostics(fail,capture,save)
        self.assertIs(error.exception,original);self.assertEqual(captured,[True])
    def test_success_and_failed_capture_are_independent(self):
        saved=[]
        result=diagnostics.with_diagnostics(lambda:17,lambda:(_ for _ in ()).throw(ValueError()),saved.append)
        self.assertEqual(result,17);self.assertFalse(saved[0]['ok'])
    def test_noninteractive_debug_is_explicit(self):
        source=pathlib.Path(__file__).with_name('prepare-inputs.py').read_text()
        self.assertIn("'HOMEBREW_DISABLE_DEBREW': '1'",source)
        self.assertIn("'--verbose','--debug','--build-from-source'",source)
if __name__=='__main__':unittest.main()
