"""Extract admitted private tar with explicit hardlink and relative-symlink ownership."""
import pathlib,tarfile,os,shutil

def extract_runtime(archive,work):
 work=pathlib.Path(work);assert not work.exists();work.mkdir(mode=0o700);work=work.resolve()
 with tarfile.open(archive) as tf:
  members=tf.getmembers();assert len(members)<=1000000 and sum(m.size for m in members)<=8*1024**3
  entries={}
  def safe(name):
   p=pathlib.PurePosixPath(name);assert name and not p.is_absolute() and '..' not in p.parts
   return str(p)
  for m in members:
   n=safe(m.name);assert n not in entries and (m.isfile() or m.isdir() or m.islnk() or m.issym());entries[n]=m
  for name,m in entries.items():
   for parent in pathlib.PurePosixPath(name).parents:
    if str(parent)!='.' and str(parent) in entries:assert entries[str(parent)].isdir(),'non-directory ancestor'
   if m.islnk():assert safe(m.linkname) in entries,'missing hardlink target'
   if m.issym():assert m.linkname and not pathlib.PurePosixPath(m.linkname).is_absolute()
  memo={}
  def regular(name,seen=None):
   if name in memo:return memo[name]
   seen=set() if seen is None else seen;assert name not in seen and len(seen)<128,'hardlink cycle';seen.add(name);m=entries[name]
   assert m.isfile() or m.islnk(),'hardlink to non-file';target=name if m.isfile() else regular(safe(m.linkname),seen);memo[name]=target;return target
  for name,m in entries.items():
   if m.islnk():regular(name)
  for name,m in entries.items():
   p=work/name
   if m.isdir():p.mkdir(parents=True,exist_ok=True);os.chmod(p,m.mode&0o777)
   elif m.isfile():
    p.parent.mkdir(parents=True,exist_ok=True)
    with tf.extractfile(m) as src,p.open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
    os.chmod(p,m.mode&0o777)
  for name,m in entries.items():
   if m.islnk():p=work/name;p.parent.mkdir(parents=True,exist_ok=True);os.link(work/regular(name),p)
  for name,m in entries.items():
   if m.issym():
    p=work/name;p.parent.mkdir(parents=True,exist_ok=True);assert (p.parent/m.linkname).resolve().is_relative_to(work),'external symlink';p.symlink_to(m.linkname)
  for name,m in entries.items():
   if m.issym():assert (work/name).resolve(strict=True).is_relative_to(work),'external or dangling symlink'
 return {'members':len(entries),'regular':sum(m.isfile() for m in members),'hardlinks':sum(m.islnk() for m in members),'symlinks':sum(m.issym() for m in members)}
