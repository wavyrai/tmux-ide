import hashlib,pathlib,tempfile,unittest
from unittest.mock import patch
import brew_core as core
from core_backup import CoreBackup
HOST={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'macOS','RUNNER_ARCH':'X64'}
class CoreTests(unittest.TestCase):
    def fixture(self,root):
        pins={'repository':core.REPOSITORY,'revision':'a'*40,'tree':'b'*40,'formulas':{'openssl@3':{'path':'Formula/o/openssl@3.rb','sha256':hashlib.sha256(b'formula').hexdigest()}}}
        replies={'core-origin':core.REPOSITORY,'core-head':pins['revision'],'core-tree':pins['tree'],'core-clean':'','brew-repository':'/usr/local/Homebrew','core-before-origin':core.REPOSITORY,'core-before-dirty':'','core-before-root':str(root),'core-before-head':'c'*40,'core-before-tree':'d'*40}
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
                    self.assertEqual(env['HOMEBREW_NO_INSTALL_FROM_API'],'1');root.mkdir();(root/'.git').mkdir()
                    self.assertEqual(argv,['brew','tap','homebrew/core'])
                return replies.get(name,'')
            with patch.object(core,'CORE',root),patch.object(core,'validate_checkout',return_value={'verified':True}):
                core.prepare_core(run,saved.append,env,HOST,pins)
                self.assertEqual(saved[-1]['after'],{'verified':True})
                self.assertEqual(next(c[2]['timeout'] for c in calls if c[0]=='core-tap'),600)
                self.assertEqual(next(c[2]['timeout'] for c in calls if c[0]=='core-fetch'),120)
                calls.clear()
                core.prepare_core(run,saved.append,env,HOST,pins)
                self.assertFalse(any(c[0]=='core-tap' for c in calls))
                self.assertTrue(saved[-1]['existed'])
                self.assertEqual(saved[-1]['before']['head'],'c'*40)
    def test_existing_dirty_nonofficial_wrongroot_and_placeholder_refuse_before_mutation(self):
        for change in [{'core-before-dirty':' M formula'}, {'core-before-origin':'https://other.invalid/core'}, {'core-before-root':'/other'}]:
            with tempfile.TemporaryDirectory() as tmp:
                root=pathlib.Path(tmp)/'core';root.mkdir();(root/'.git').mkdir()
                pins,replies,_=self.fixture(root);replies.update(change);calls=[];saved=[]
                def run(name,argv,**kwargs):calls.append(name);return replies.get(name,'')
                with patch.object(core,'CORE',root),self.assertRaises(AssertionError):
                    core.prepare_core(run,saved.append,{},HOST,pins)
                self.assertFalse(any(name in calls for name in ['core-tap','core-fetch','core-checkout']))
                self.assertTrue(saved[-1]['before'])
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)/'core';root.mkdir();pins,replies,_=self.fixture(root);calls=[]
            with patch.object(core,'CORE',root),self.assertRaises(AssertionError):
                core.prepare_core(lambda name,argv,**kw:(calls.append(name) or replies.get(name,'')),lambda value:None,{},HOST,pins)
            self.assertEqual(calls,['brew-repository'])
    def test_dirty_official_checkout_is_preserved_then_replacement_admitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp)/'core';root.mkdir();(root/'.git').mkdir();(root/'custom').write_text('retain')
            pins,replies,_=self.fixture(root);replies['core-before-dirty']=' M Formula/r/rustup.rb'
            replies.update({'core-replacement-root':str(root),'core-replacement-origin':core.REPOSITORY,'core-replacement-clean':''})
            calls=[];backup=CoreBackup(root,pathlib.Path(tmp)/'backup',lambda value:None)
            def run(name,argv,**kwargs):
                calls.append(name)
                if name=='core-replacement-tap':root.mkdir();(root/'.git').mkdir()
                return replies.get(name,'')
            with patch.object(core,'CORE',root),patch.object(core,'validate_checkout',return_value={'verified':True}):
                core.prepare_core(run,lambda value:None,{},HOST,pins,backup)
            self.assertIn('core-fetch',calls);self.assertIsNotNone(backup.replacement)
            backup.restore();self.assertEqual((root/'custom').read_text(),'retain')
    def test_wrong_host_refuses_before_commands(self):
        pins,_,_=self.fixture(pathlib.Path('/unused'));calls=[]
        with self.assertRaises(AssertionError):core.prepare_core(lambda *a,**k:calls.append(a),lambda x:None,{}, {},pins)
        self.assertEqual(calls,[])
if __name__=='__main__':unittest.main()
