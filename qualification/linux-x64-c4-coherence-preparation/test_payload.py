import pathlib,tempfile,sys,unittest,os,json
R=pathlib.Path(__file__).resolve().parent;sys.path.insert(0,str(R))
from payload import package_payload,ledger
class Payload(unittest.TestCase):
 def test_git_modes_links_and_complete_roundtrip(self):
  with tempfile.TemporaryDirectory() as tmp:
   r=pathlib.Path(tmp);w=r/'work';(w/'current/source/.git/objects').mkdir(parents=True);p=w/'current/source/.git/objects/object';p.write_bytes(b'object');p.chmod(0o640);(w/'current/ref').symlink_to('source/.git/objects/object');(w/'unrelated/.git/objects/info').mkdir(parents=True);(w/'unrelated/.git/objects/info/alternates').write_text('/external')
   proof=package_payload(w,['current'],r/'payload.tar',r/'roundtrip');self.assertTrue(proof['gitIncluded']);self.assertEqual(proof['ledger']['current/source/.git/objects/object']['mode'],0o640);self.assertEqual(proof['ledger']['current/ref']['target'],'source/.git/objects/object')
   q=r/'roundtrip/current/ref';q.unlink();q.symlink_to('./source/.git/objects/object');self.assertNotEqual(ledger(r/'roundtrip',['current']),proof['ledger'])
 def test_gitfile_alternates_and_external_link_refused(self):
  for kind in ['gitfile','alternates','external']:
   with tempfile.TemporaryDirectory() as tmp:
    r=pathlib.Path(tmp);w=r/'work';(w/'current').mkdir(parents=True)
    if kind=='gitfile':(w/'current/.git').write_text('gitdir: /external')
    elif kind=='alternates':(w/'current/.git/objects/info').mkdir(parents=True);(w/'current/.git/objects/info/alternates').write_text('/external')
    else:(w/'outside').write_text('outside');(w/'current/link').symlink_to('../outside')
    with self.assertRaises(AssertionError):package_payload(w,['current'],r/'payload.tar',r/'roundtrip')
if __name__=='__main__':unittest.main()
