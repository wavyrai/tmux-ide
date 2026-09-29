import copy, unittest, tempfile, pathlib, os
from openssl_link import remedy_known_openssl, LINK, TARGET, CELLAR
ENV={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'macOS','RUNNER_ARCH':'X64'}
KNOWN={'path':LINK,'state':'symlink','target':TARGET,'resolved':CELLAR+'/1.1.1w/bin/openssl','device':1,'inode':2,'file':{'sha256':'known','device':1,'inode':3,'size':4}}
ABSENT={'path':LINK,'state':'absent'}
class LinkTests(unittest.TestCase):
    def fixture(self, states=None, overrides=None, unlink_error=False):
        states=iter(states if states is not None else [KNOWN,KNOWN,ABSENT]);calls=[];saved={}
        replies={'openssl1-prefix':'/usr/local/opt/openssl@1.1','openssl1-cellar':CELLAR,'openssl1-versions':'openssl@1.1 1.1.1w','openssl1-files':KNOWN['resolved'],'openssl1-unlink':'Unlinking exact formula'}
        replies.update(overrides or {})
        def run(name,argv):
            calls.append((name,argv))
            if name=='openssl1-unlink' and unlink_error:raise RuntimeError('unlink failed')
            return replies[name]
        def act(env=ENV):return remedy_known_openssl(run,lambda name,value:saved.update({name:value}),env,lambda:copy.deepcopy(next(states)),lambda path:calls.append(('exact-symlink-unlink',path)))
        return act,calls,saved
    def test_known_link_revalidates_and_uses_only_supported_formula_unlink(self):
        act,calls,saved=self.fixture();act()
        self.assertEqual(calls[-1],('openssl1-unlink',['brew','unlink','openssl@1.1']))
        self.assertEqual(saved['openssl-link-before.json'],saved['openssl-link-revalidated.json'])
        self.assertEqual(saved['openssl-link-after.json']['observation'],ABSENT)
    def test_absent_link_has_no_brew_mutation(self):
        act,calls,saved=self.fixture([ABSENT]);act();self.assertEqual(calls,[])
        self.assertEqual(saved['openssl-link-after.json']['action'],'not-needed')
    def test_unknown_targets_regular_files_and_wrong_formula_refuse(self):
        for change in [{'target':'/usr/local/opt/other/bin/openssl'},{'state':'other'},{'resolved':'/tmp/replacement/bin/openssl'},{'path':'/other/bin/openssl'}]:
            with self.subTest(change=change):
                act,calls,saved=self.fixture([{**KNOWN,**change}])
                with self.assertRaises(AssertionError):act()
                self.assertEqual(calls,[])
        for change in [{'openssl1-prefix':'/unexpected'},{'openssl1-files':'/unexpected'},{'openssl1-versions':'openssl@1.1 1.1.1v'}]:
            with self.subTest(change=change):
                act,calls,saved=self.fixture(overrides=change)
                with self.assertRaises(AssertionError):act()
                self.assertFalse(any(name=='openssl1-unlink' for name,_ in calls))
    def test_changed_incarnation_does_not_unlink(self):
        act,calls,saved=self.fixture([KNOWN,{**KNOWN,'inode':99}])
        with self.assertRaises(AssertionError):act()
        self.assertFalse(any(name=='openssl1-unlink' for name,_ in calls))
    def test_unlink_failure_retains_after_receipt_and_propagates(self):
        act,calls,saved=self.fixture([KNOWN,KNOWN,KNOWN],unlink_error=True)
        with self.assertRaises(RuntimeError):act()
        self.assertEqual(saved['openssl-link-after.json']['observation'],KNOWN)
    def test_post_unlink_replacement_is_retained_and_not_overwritten(self):
        replacement={**KNOWN,'target':'/unexpected/replacement'}
        act,calls,saved=self.fixture([KNOWN,KNOWN,replacement])
        with self.assertRaises(AssertionError):act()
        self.assertEqual(saved['openssl-link-after.json']['observation'],replacement)
        self.assertEqual(sum(name=='openssl1-unlink' for name,_ in calls),1)
    def test_unchanged_leftover_removes_only_exact_symlink(self):
        act,calls,saved=self.fixture([KNOWN,KNOWN,KNOWN,KNOWN,ABSENT]);act()
        self.assertEqual(calls[-1],('exact-symlink-unlink',LINK))
        self.assertEqual(saved['openssl-link-fallback-revalidated.json'],KNOWN)
        self.assertEqual(saved['openssl-link-after.json'],{'action':'verified-leftover-symlink-unlink','observation':ABSENT})
    def test_changed_leftover_on_final_revalidation_is_not_removed(self):
        act,calls,saved=self.fixture([KNOWN,KNOWN,KNOWN,{**KNOWN,'inode':99}])
        with self.assertRaises(AssertionError):act()
        self.assertFalse(any(name=='exact-symlink-unlink' for name,_ in calls))
    def test_failed_supported_unlink_never_runs_fallback(self):
        act,calls,saved=self.fixture([KNOWN,KNOWN,KNOWN],unlink_error=True)
        with self.assertRaises(RuntimeError):act()
        self.assertFalse(any(name=='exact-symlink-unlink' for name,_ in calls))
    def test_filesystem_fallback_unlinks_entry_and_preserves_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);target=root/'target';target.write_bytes(b'preserve')
            link=root/'link';link.symlink_to(target)
            # Exercise unlink semantics on an isolated symlink only.
            states=iter([KNOWN,KNOWN,KNOWN,KNOWN,ABSENT])
            replies={'openssl1-prefix':'/usr/local/opt/openssl@1.1','openssl1-cellar':CELLAR,'openssl1-versions':'openssl@1.1 1.1.1w','openssl1-files':KNOWN['resolved'],'openssl1-unlink':''}
            def remove(path):
                self.assertEqual(path,LINK)
                os.unlink(link)
            remedy_known_openssl(lambda name,argv:replies[name],lambda name,value:None,ENV,lambda:copy.deepcopy(next(states)),remove)
            self.assertFalse(link.is_symlink());self.assertEqual(target.read_bytes(),b'preserve')
    def test_local_or_self_hosted_machine_refuses_before_observation(self):
        for env in [{},{**ENV,'RUNNER_ENVIRONMENT':'self-hosted'}]:
            act,calls,saved=self.fixture([])
            with self.assertRaises(AssertionError):act(env)
            self.assertEqual(calls,[]);self.assertEqual(saved,{})
if __name__=='__main__':unittest.main()
