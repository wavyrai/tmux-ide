import hashlib,pathlib,tempfile,unittest
from unittest.mock import patch
import brew_core as core
HOST={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'macOS','RUNNER_ARCH':'X64'}
class CoreTests(unittest.TestCase):
    def fixture(self,root):
        pins={'repository':core.REPOSITORY,'revision':'a'*40,'tree':'b'*40,'formulas':{'openssl@3':{'path':'Formula/o/openssl@3.rb','sha256':hashlib.sha256(b'formula').hexdigest()}}}
        replies={'core-origin':core.REPOSITORY,'core-head':pins['revision'],'core-tree':pins['tree'],'core-clean':'','brew-repository':'/usr/local/Homebrew','core-tap-origin':core.REPOSITORY,'core-tap-clean':''}
        def run(name,argv,**kwargs):return replies.get(name,'')
        return pins,replies,run
    def test_checkout_identity_and_formula_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);p=root/'Formula/o/openssl@3.rb';p.parent.mkdir(parents=True);p.write_bytes(b'formula')
            pins,replies,run=self.fixture(root)
            self.assertFalse(core.validate_checkout(run,pins,root)['installFromApi'])
            for name in ['core-origin','core-head','core-tree','core-clean']:
                original=replies[name];replies[name]='unexpected'
                with self.assertRaises(AssertionError):core.validate_checkout(run,pins,root)
                replies[name]=original
            p.write_bytes(b'tampered')
            with self.assertRaises(AssertionError):core.validate_checkout(run,pins,root)
    def test_env_precedes_supported_tap_and_only_fresh_owned_path_is_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)/'core';pins,replies,_=self.fixture(root);env={};calls=[];saved=[]
            def run(name,argv,**kwargs):
                calls.append((name,argv,kwargs))
                if name=='core-tap':
                    self.assertEqual(env['HOMEBREW_NO_INSTALL_FROM_API'],'1');root.mkdir()
                    self.assertEqual(argv,['brew','tap','homebrew/core'])
                return replies.get(name,'')
            with patch.object(core,'CORE',root),patch.object(core,'validate_checkout',return_value={'verified':True}):
                core.prepare_core(run,saved.append,env,HOST,pins)
                self.assertEqual(saved,[{'verified':True}])
                self.assertEqual(next(c[2]['timeout'] for c in calls if c[0]=='core-tap'),600)
                self.assertEqual(next(c[2]['timeout'] for c in calls if c[0]=='core-fetch'),120)
                before=len(calls)
                with self.assertRaises(AssertionError):core.prepare_core(run,saved.append,env,HOST,pins)
                self.assertEqual(len(calls),before)
    def test_wrong_host_refuses_before_commands(self):
        pins,_,_=self.fixture(pathlib.Path('/unused'));calls=[]
        with self.assertRaises(AssertionError):core.prepare_core(lambda *a,**k:calls.append(a),lambda x:None,{}, {},pins)
        self.assertEqual(calls,[])
if __name__=='__main__':unittest.main()
