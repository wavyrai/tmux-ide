"""Closed standalone Git payload: exact member types, modes, links and bytes."""
import pathlib,tarfile,os,hashlib,stat

def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def ledger(base,roots):
 base=pathlib.Path(base).resolve();entries={}
 for name in roots:
  root=base/name
  assert root.exists() and not root.is_symlink()
  for p in [root,*root.rglob('*')] if root.is_dir() else [root]:
   rel=str(p.relative_to(base));s=p.lstat();kind='link' if stat.S_ISLNK(s.st_mode) else 'dir' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else None
   assert kind,rel;item={'kind':kind,'mode':stat.S_IMODE(s.st_mode)}
   if kind=='link':
    text=os.readlink(p);assert not os.path.isabs(text);item['target']=text
   elif kind=='file':item.update(bytes=s.st_size,sha256=digest(p))
   if p.name=='.git':assert kind=='dir' and not (p/'objects/info/alternates').exists()
   entries[rel]=item
 for rel,item in entries.items():
  if item['kind']=='link':
   dest=(base/rel).resolve(strict=True);assert dest.is_relative_to(base) and str(dest.relative_to(base)) in entries,rel
 return entries

def package_payload(work,roots,archive,roundtrip):
 work=pathlib.Path(work).resolve();roundtrip=pathlib.Path(roundtrip).resolve();before=ledger(work,roots)
 with tarfile.open(archive,'x',dereference=False) as tf:
  for rel in sorted(before):tf.add(work/rel,arcname=rel,recursive=False)
 with tarfile.open(archive) as tf:
  members=tf.getmembers();assert len(members)==len(before) and len({m.name for m in members})==len(before) and {m.name for m in members}==set(before)
  for m in members:
   item=before[m.name];assert (m.mode&0o7777)==item['mode']
   if item['kind']=='link':assert m.issym() and m.linkname==item['target']
   elif item['kind']=='dir':assert m.isdir()
   else:
    assert m.isfile() or m.islnk()
    if m.islnk():assert m.linkname in before and before[m.linkname]['kind']=='file' and before[m.linkname]['sha256']==item['sha256']
    else:assert m.size==item['bytes']
  roundtrip.mkdir();tf.extractall(roundtrip)
 after=ledger(roundtrip,roots);assert after==before,'Payload roundtrip ledger mismatch'
 return {'roundtripVerified':True,'gitIncluded':True,'members':len(before),'files':sum(v['kind']=='file' for v in before.values()),'ledger':before,'absoluteSymlinksAllowed':False}
