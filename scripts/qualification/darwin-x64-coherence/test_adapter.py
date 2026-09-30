import unittest,tempfile,pathlib,json,subprocess,sys,importlib.util
from stage import stage,HERE
from binding import u,archive
class Adapter(unittest.TestCase):
 def fixture(self,root):
  source=root/'source';tsx=source/'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs';tsx.parent.mkdir(parents=True);tsx.write_text('fixture')
  p={'source':str(source)}
  for name in ['cli','node','native','stock']:
   f=root/name;f.write_text(name);p[name]=str(f)
  return {'paths':p,'sourceCommit':'c'*40,'sourceTree':'d'*40}
 def test_both_workloads_and_oracles_unchanged(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);b=self.fixture(root)
   for mode in ['native','stock']:
    out=root/('out-'+mode);s=stage(b,mode,out)
    for p in (HERE/'accepted'/mode).iterdir():
     if p.name not in ['daemon.ts','owned-harness.mjs','admission.mjs']:self.assertEqual(p.read_bytes(),(out/p.name).read_bytes(),p.name)
    self.assertEqual(s['executionAuthorized'],False)
    self.assertEqual(json.loads((out/'package.json').read_text()),{'type':'module'})
    descriptor=json.loads((out/'admission.json').read_text())
    self.assertEqual(descriptor['overlay'][str(out.resolve()/'package.json')],u.sha(out/'package.json'))
    self.assertEqual(s['argv'][-2],str(out.resolve()/'results'))
    self.assertEqual(json.loads((out/'admission.json').read_text())['workload'],{'clients':[2,4,8],'records':500,'resizes':20,'stalledConsumers':1})
    self.assertEqual((out/'source').resolve(),pathlib.Path(b['paths']['source']).resolve())
 def test_unknown_mode_never_allocates(self):
  with tempfile.TemporaryDirectory() as t:
   out=pathlib.Path(t)/'out'
   with self.assertRaises(AssertionError):stage({},'grid-reference',out)
   self.assertFalse(out.exists())
 def test_existing_evidence_never_overwritten(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);b=self.fixture(root);out=root/'out';out.mkdir();(out/'old').write_text('preserved')
   with self.assertRaises(AssertionError):stage(b,'stock',out)
   self.assertEqual((out/'old').read_text(),'preserved')
 def test_held_runner_allocates_nothing(self):
  with tempfile.TemporaryDirectory() as t:
   out=pathlib.Path(t)/'out';p=subprocess.run([sys.executable,str(HERE/'runner.py'),str(out)],capture_output=True)
   self.assertNotEqual(p.returncode,0);self.assertIn(b'Held recipe',p.stderr);self.assertFalse(out.exists())
 def test_actual_cli_and_stock_proof_shapes_keep_all_pinned_checks(self):
  # CLI payload proof14c2 has no sha256 field; stock payload proof carries it.
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);payload=root/'payload';payload.mkdir();member=payload/'input';member.write_bytes(b'exact');member.chmod(0o600)
   zipfile=root/'archive.zip';zipfile.write_bytes(b'closed zip');tar=root/'archive.tar';tar.write_bytes(b'closed tar');proof=root/'proof.json'
   ledger={'input':{'kind':'file','mode':0o600,'bytes':5,'sha256':u.sha(member)}}
   common={'roundtripVerified':True,'members':1,'files':1,'ledger':ledger,'gitIncluded':True,'absoluteSymlinksAllowed':False}
   pin={'zipSha256':u.sha(zipfile),'zipBytes':zipfile.stat().st_size,'tarSha256':u.sha(tar),'tarBytes':tar.stat().st_size}
   def write(value):
    proof.write_text(json.dumps(value));pin['payloadProofSha256']=u.sha(proof)
   def check():return archive(payload,zipfile,tar,proof,pin,['input'])
   for value in [common,dict(common,sha256=pin['tarSha256'])]:
    write(value);self.assertEqual(check(),1)
    proof.write_text(proof.read_text()+' ')
    with self.assertRaises(AssertionError):check()
    write(value);member.write_bytes(b'wrong')
    with self.assertRaises(AssertionError):check()
    member.write_bytes(b'exact');member.chmod(0o644)
    with self.assertRaises(AssertionError):check()
    member.chmod(0o600);tar.write_bytes(b'wrong tar')
    with self.assertRaises(AssertionError):check()
    tar.write_bytes(b'closed tar');zipfile.write_bytes(b'wrong zip')
    with self.assertRaises(AssertionError):check()
    zipfile.write_bytes(b'closed zip')
   write(dict(common,sha256='0'*64))
   with self.assertRaises(AssertionError):check()
 def test_member_verifier_rejects_content_and_escape(self):
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);p=root/'input';p.write_text('exact');p.chmod(0o600)
   ledger={'input':{'kind':'file','mode':0o600,'bytes':5,'sha256':u.sha(p)}}
   self.assertEqual(u.verify_tree(root,ledger,['input']),1);p.write_text('wrong')
   with self.assertRaises(AssertionError):u.verify_tree(root,ledger,['input'])
   with self.assertRaises(AssertionError):u.closed_path(root,'../escape')
if __name__=='__main__':unittest.main()
