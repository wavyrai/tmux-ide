import pathlib,tempfile,json,shutil,stat,os,unittest,importlib.util
from unittest.mock import patch
import derived_runtime as d
HERE=pathlib.Path(__file__).resolve().parent
ROOT=pathlib.Path(os.environ['TMUX_QUAL_SOURCE']).resolve()
s=importlib.util.spec_from_file_location('reviewed_binding',HERE/'binding.py');binding=importlib.util.module_from_spec(s);s.loader.exec_module(binding)

class Derivation(unittest.TestCase):
 def fixture(self,base):
  root=base/'runtime';root.mkdir()
  for r in d.ROOTS:
   if r.endswith('.json'):(root/r).write_text('{}')
   else:(root/r).mkdir()
  target=root/d.HELPER;target.parent.mkdir(parents=True)
  shutil.copyfile(ROOT/'node_modules/.pnpm/node-pty@1.2.0-beta.12/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',target);target.chmod(0o700)
  untouched=root/'source/unchanged';untouched.write_bytes(b'unchanged');untouched.chmod(0o600)
  ledger={}
  for p in root.rglob('*'):
   row={'kind':'dir' if p.is_dir() else 'file','mode':stat.S_IMODE(p.lstat().st_mode)}
   if p.is_file():row.update(bytes=p.stat().st_size,sha256=d.sha(p))
   ledger[str(p.relative_to(root))]=row
  proof=base/'proof.json';proof.write_text(json.dumps({'roundtripVerified':True,'gitIncluded':True,'absoluteSymlinksAllowed':False,'members':len(ledger),'ledger':ledger}))
  zipfile=base/'original.zip';zipfile.write_bytes(b'original frozen ZIP fixture');tar=base/'original.tar';tar.write_bytes(b'original frozen tar fixture')
  pins={'zipBytes':zipfile.stat().st_size,'zipSha256':d.sha(zipfile),'tarBytes':tar.stat().st_size,'tarSha256':d.sha(tar),'payloadProofSha256':d.sha(proof)}
  return {'root':str(root),'zip':str(zipfile),'tar':str(tar),'proof':str(proof),'pins':pins},target,untouched
 def test_exact_mode_only_derivation_and_strict_post(self):
  with tempfile.TemporaryDirectory() as temp:
   base=pathlib.Path(temp).resolve();a,target,other=self.fixture(base);original={key:pathlib.Path(a[key]).read_bytes() for key in ['zip','tar','proof']};before=target.read_bytes()
   receipt=d.prepare(a,base/'receipt',binding.verify_tree)
   self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o755);self.assertEqual(target.read_bytes(),before);self.assertEqual(stat.S_IMODE(other.stat().st_mode),0o600)
   for key,value in original.items():self.assertEqual(pathlib.Path(a[key]).read_bytes(),value)
   self.assertTrue(d.verify(a,receipt,binding.verify_tree)['derivedTreeVerified'])
   with self.assertRaises(AssertionError):binding.verify_tree(pathlib.Path(a['root']),json.loads(original['proof'])['ledger'],d.ROOTS)
   with self.assertRaises(AssertionError):d.prepare(a,base/'second',binding.verify_tree)
   self.assertFalse((base/'second').exists())
 def test_original_tree_uncertainty_refuses_before_chmod(self):
  for mutation in ['mode','bytes','extra','helpermode']:
   with tempfile.TemporaryDirectory() as temp:
    base=pathlib.Path(temp).resolve();a,target,other=self.fixture(base)
    if mutation=='mode':other.chmod(0o644)
    elif mutation=='bytes':other.write_bytes(b'changed')
    elif mutation=='extra':(other.parent/'extra').write_text('unexpected')
    else:target.chmod(0o755)
    with self.assertRaises(AssertionError):d.prepare(a,base/'receipt',binding.verify_tree)
    self.assertFalse((base/'receipt').exists())
    if mutation!='helpermode':self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o700)
 def test_post_rejects_every_unlisted_change_and_input_tamper(self):
  for mutation in ['mode','bytes','extra','helpermode','proof','zip','tar','receipt','derivedledger']:
   with tempfile.TemporaryDirectory() as temp:
    base=pathlib.Path(temp).resolve();a,target,other=self.fixture(base);receipt=d.prepare(a,base/'receipt',binding.verify_tree)
    if mutation=='mode':other.chmod(0o644)
    elif mutation=='bytes':other.write_bytes(b'changed')
    elif mutation=='extra':(other.parent/'extra').write_text('unexpected')
    elif mutation=='helpermode':target.chmod(0o700)
    elif mutation=='receipt':pathlib.Path(receipt['receipt']).write_text('{}');receipt['receiptSha256']=d.sha(receipt['receipt'])
    elif mutation=='derivedledger':
     p=pathlib.Path(receipt['ledger']);data=json.loads(p.read_text());data['source/unchanged']['mode']=0o644;p.write_bytes(d.encoded(data));receipt['ledgerSha256']=d.sha(p)
    else:pathlib.Path(a[mutation]).write_bytes(b'tampered')
    with self.assertRaises((AssertionError,ValueError)):d.verify(a,receipt,binding.verify_tree)
 def test_partial_preparation_failure_never_restores_mode(self):
  with tempfile.TemporaryDirectory() as temp:
   base=pathlib.Path(temp).resolve();a,target,other=self.fixture(base)
   def verify(root,ledger,roots):
    if ledger[d.HELPER]['mode']==0o755:raise RuntimeError('injected post-derivation failure')
    return binding.verify_tree(root,ledger,roots)
   with self.assertRaises(RuntimeError):d.prepare(a,base/'receipt',verify)
   self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o755)
   self.assertFalse(json.loads((base/'receipt/failure.json').read_text())['originalRestored'])
   self.assertFalse((base/'receipt/derivation.json').exists())
 def test_hardlink_alias_and_changed_helper_pin_refused(self):
  with tempfile.TemporaryDirectory() as temp:
   base=pathlib.Path(temp).resolve();a,target,other=self.fixture(base);os.link(target,base/'outside-alias')
   with self.assertRaises(AssertionError):d.prepare(a,base/'receipt',binding.verify_tree)
   self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o700)
if __name__=='__main__':unittest.main()
