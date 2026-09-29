"""Closed transport intake only: verify exact ZIP/tar/ledger; no executable launch."""
import pathlib,json,zipfile,tarfile,shutil,os
from binding import sha

def extract_tar(archive,target,ledger):
 target=pathlib.Path(target);assert not target.exists();target.mkdir(mode=0o700)
 def safe(name):
  p=pathlib.PurePosixPath(name);assert name and not p.is_absolute() and '..' not in p.parts and str(p)==name
  return target/name
 with tarfile.open(archive) as tf:
  members=tf.getmembers();assert len(members)<=200000 and sum(m.size for m in members)<=8*1024**3
  assert len(members)==len(ledger) and {m.name for m in members}==set(ledger)
  for m in members:
   safe(m.name);row=ledger[m.name];assert m.mode&0o7777==row['mode']
   if row['kind']=='link':
    assert m.issym() and m.linkname==row['target'] and not os.path.isabs(m.linkname)
    assert (safe(m.name).parent/m.linkname).resolve().is_relative_to(target.resolve())
   elif row['kind']=='dir':assert m.isdir()
   else:
    assert row['kind']=='file' and (m.isfile() or m.islnk())
    if m.islnk():assert m.linkname in ledger and ledger[m.linkname]['kind']=='file' and ledger[m.linkname]['sha256']==row['sha256']
    else:assert m.size==row['bytes']
  # Never traverse archive symlinks: create all directories/files first, links last.
  for m in members:
   if m.issym():continue
   dest=safe(m.name);dest.parent.mkdir(parents=True,exist_ok=True)
   if m.isdir():dest.mkdir(exist_ok=True);dest.chmod(m.mode&0o7777)
   else:
    with tf.extractfile(m) as src,dest.open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
    dest.chmod(m.mode&0o7777);os.utime(dest,(m.mtime,m.mtime));assert sha(dest)==ledger[m.name]['sha256']
  for m in members:
   if m.issym():dest=safe(m.name);dest.parent.mkdir(parents=True,exist_ok=True);dest.symlink_to(m.linkname)
 for rel,row in ledger.items():
  if row['kind']=='link':assert safe(rel).resolve(strict=True).is_relative_to(target.resolve())

def intake(zip_path,pins,out):
 out=pathlib.Path(out);assert not out.exists();out.mkdir(mode=0o700)
 assert pathlib.Path(zip_path).stat().st_size==pins['zipBytes'] and sha(zip_path)==pins['zipSha256']
 with zipfile.ZipFile(zip_path) as z:
  assert len(z.namelist())==len(set(z.namelist()))
  for member,dest,max_bytes,digest in [(pins['tarMember'],'payload.tar',pins['tarBytes'],pins['tarSha256']),(pins['proofMember'],'payload-proof.json',100*1024**2,pins['payloadProofSha256'])]:
   info=z.getinfo(member);assert info.file_size<=max_bytes
   with z.open(info) as src,(out/dest).open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
   assert sha(out/dest)==digest
 assert (out/'payload.tar').stat().st_size==pins['tarBytes']
 proof=json.loads((out/'payload-proof.json').read_text());assert proof['roundtripVerified'] is True
 extract_tar(out/'payload.tar',out/'payload',proof['ledger'])
 return out/'payload'
