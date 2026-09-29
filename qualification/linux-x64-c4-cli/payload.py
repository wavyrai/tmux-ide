"""Closed private payload: links must resolve inside an included root, not merely /work."""
import pathlib,tarfile,os,hashlib

def digest(p):
 h=hashlib.sha256()
 with p.open("rb") as f:
  for chunk in iter(lambda:f.read(1024*1024),b""):h.update(chunk)
 return h.digest()

def package_payload(work,roots,archive,roundtrip):
 work=pathlib.Path(work).resolve();roundtrip=pathlib.Path(roundtrip).resolve();allowed=[work/n for n in roots];paths=[]
 for root in allowed:paths.extend([root] if root.is_file() else [root,*root.rglob('*')])
 paths=[p for p in paths if '.git' not in p.relative_to(work).parts]
 included={p.relative_to(work) for p in paths}
 for p in paths:
  if p.is_symlink():
   resolved=p.resolve(strict=True)
   assert resolved.is_relative_to(work) and resolved.relative_to(work) in included, 'Unpacked dependency target: '+str(p)
   assert not os.path.isabs(os.readlink(p)), 'Absolute payload link: '+str(p)
 with tarfile.open(archive,'w',dereference=False) as tf:
  for p in paths:tf.add(p,arcname=str(p.relative_to(work)),recursive=False)
 roundtrip.mkdir()
 with tarfile.open(archive) as tf:tf.extractall(roundtrip)
 count=0
 for p in paths:
  q=roundtrip/p.relative_to(work)
  assert (p.lstat().st_mode&0o7777)==(q.lstat().st_mode&0o7777)
  if p.is_symlink():assert q.resolve(strict=True).is_relative_to(roundtrip) and os.readlink(p)==os.readlink(q)
  if p.is_file():
   assert digest(p)==digest(q);count+=1
 return {'roundtripVerified':True,'files':count,'gitIncluded':False,'absoluteSymlinksAllowed':False}
