import unittest,tempfile,pathlib,json,copy,os
from binding import closed_path,rebind,verify_tree,validate_receipts,SOURCE,OBSERVER,NATIVE,ROOTS,sha
from stage import bind_case,bind_daemon,stage_sources,once
BASE=pathlib.Path(__file__).resolve().parent
PATHS={'source':'/private/new/source','cli':'/private/new/source/.tasks/qualified-cli/cli.mjs','node':'/private/new/admitted/tools/node/bin/node','native':'/private/new/admitted/qualified-native/bundle/tmux'}
class BindingTests(unittest.TestCase):
 def test_actual_receipts_have_consistent_identity_but_missing_reference_rejects(self):
  fixture=json.loads((BASE/'test-receipts.json').read_text());receipt=fixture['receipt'];binding=fixture['binding'];pins=json.loads((BASE/'held-spec.json').read_text())['runtimeArtifact']
  pins=copy.deepcopy(pins);pins['matchedReference']=None
  with self.assertRaisesRegex(AssertionError,'Matched reference'):validate_receipts(binding,receipt,pins)
  pins=copy.deepcopy(pins);pins['matchedReference']={'accepted':True,'nativeSha256':NATIVE,'libraryBytesMatchNative':True,'journalPatch':None}
  validate_receipts(binding,receipt,pins)
  for key,value in [('sourceCommit','0'*40),('observerDefaultBatchMs',0),('nativeDefaultEnabled',True)]:
   wrong=dict(binding);wrong[key]=value
   with self.assertRaises(AssertionError):validate_receipts(wrong,receipt,pins)
 def test_path_escape_and_foreign_prefix_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   p=pathlib.Path(t);(p/'source').mkdir();(p/'source/a').write_text('x');(p/'escape').symlink_to('/etc/passwd')
   self.assertEqual(rebind(p,'/old','/old/source/a'),str((p/'source/a').resolve()))
   for rel in ['../passwd','/etc/passwd','escape','source/../source/a']:
    with self.assertRaises(AssertionError):closed_path(p,rel)
   with self.assertRaises(AssertionError):rebind(p,'/old','/older/source/a')
 def test_full_tree_changed_bytes_extra_members_modes_and_link_target(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);ledger={}
   for name in ROOTS:(root/name).write_text(name)
   for p in root.iterdir():ledger[p.name]={'kind':'file','mode':p.stat().st_mode&0o7777,'bytes':p.stat().st_size,'sha256':sha(p)}
   self.assertEqual(verify_tree(root,ledger),6)
   (root/'source').write_text('tampered')
   with self.assertRaises(AssertionError):verify_tree(root,ledger)
   (root/'source').write_text('source');os.chmod(root/'source',0o777)
   with self.assertRaises(AssertionError):verify_tree(root,ledger)
 def test_actual_cpu_and_idle_transform_preserve_measurement_bodies(self):
  for lane in ['cpu','idle']:
   text=(BASE/'upstream'/lane/'case.mjs').read_text();bound=bind_case(text,PATHS,lane=='idle')
   self.assertIn("const n=spec.lane==='cpu'?1500:1;",bound)
   self.assertIn("result.elapsedSeconds=(performance.now()-started)/1000",bound)
   self.assertIn("fixtureSelfCpuSeconds:(fixtureUsage.user+fixtureUsage.system)/1e6",bound)
   self.assertIn("fenceNativeTmuxCommand(['-N','-u','kill-server']",bound)
   self.assertNotIn("await command(['kill-server'])",bound)
   self.assertIn('prior.startIdentity',bound)
   if lane=='idle':self.assertIn('finalCaptureDrained(evidence,status,{setupIssuer,pairIssuers:issuers,finalIssuer})',bound)
   with self.assertRaises(AssertionError):bind_case(bound,PATHS,lane=='idle')
 def test_no_build_fallback_in_actual_daemon_fixtures(self):
  for lane,name in [('cpu','daemon-prebuilt.ts'),('idle','daemon-traced.ts')]:
   text=bind_daemon((BASE/'upstream'/lane/name).read_text(),PATHS)
   self.assertNotIn('build-cli.mjs',text);self.assertNotIn('ensureDaemonBundle',text)
   self.assertIn('Reviewed prebuilt CLI digest required',text);self.assertIn('actual !== options.prebuiltCliSha256',text)
   self.assertIn(PATHS['cli'],text);self.assertIn('"--headless"',text)
 def test_actual_whole_stage_is_external_and_held(self):
  with tempfile.TemporaryDirectory() as t:
   target=pathlib.Path(t)/'overlay';files=stage_sources({'executionAuthorized':False,'runtimePatch':None,'paths':PATHS},target)
   self.assertGreater(len(files),35)
   self.assertFalse(json.loads((target/'staging.json').read_text())['executionAuthorized'])
   for lane in ['parser','metadata','tail']:
    text=(target/lane/'candidate.ts').read_text();self.assertNotIn('/Users/thijs',text);self.assertIn(PATHS['source'],text)
   self.assertEqual((target/'cpu/campaign.py').read_bytes(),(BASE/'upstream/cpu/campaign.py').read_bytes())
   with self.assertRaisesRegex(AssertionError,'Fresh overlay'):stage_sources({'executionAuthorized':False,'runtimePatch':None,'paths':PATHS},target)

class ImportRootTests(unittest.TestCase):
 def test_actual_staged_import_roots_resolve_without_evaluation(self):
  import subprocess
  self.assertIn('TMUX_QUAL_SOURCE',os.environ,'Pass the inspected source/dependency root explicitly; recipe depth is not source identity')
  self.assertIn('TMUX_QUAL_NODE',os.environ,'Pass the source-check Node executable explicitly')
  source=pathlib.Path(os.environ['TMUX_QUAL_SOURCE']).resolve(strict=True)
  node=pathlib.Path(os.environ['TMUX_QUAL_NODE'])
  self.assertTrue(node.is_absolute() and node.is_file())
  self.assertTrue((source/'package.json').is_file() and (source/'packages').is_dir())
  with tempfile.TemporaryDirectory() as t:
   target=pathlib.Path(t)/'overlay';paths=dict(PATHS,source=str(source),cli=str(source/'.tasks/unused-qualified-cli.mjs'))
   stage_sources({'executionAuthorized':False,'runtimePatch':None,'paths':paths},target)
   result=subprocess.run([str(node),str(BASE/'check-import-roots.mjs'),str(target),str(source)],capture_output=True,text=True,timeout=15)
   self.assertEqual(result.returncode,0,result.stderr)
   print(result.stdout.strip())
   for lane in ['cpu','idle','parser']:
    entry='case.mjs' if lane!='parser' else 'echo.mjs'
    result=subprocess.run([str(node),'--check',str(target/lane/entry)],capture_output=True,text=True,timeout=15)
    self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
