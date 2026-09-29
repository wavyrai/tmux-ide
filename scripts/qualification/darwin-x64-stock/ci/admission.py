"""Local archive/pin admission. Unknown actual inputs never authorize commands."""
import hashlib,json,pathlib,re,tarfile,shutil,os,stat
from payload import ledger
COMMIT='c95f246ae4a87e86f5299a4d3b594f086f2333f2';TREE='faf91085a562009c6b64e8fcea925ed92f861c06'
def sha(p):
 h=hashlib.sha256()
 with pathlib.Path(p).open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
def ready(p):
 assert p['executionAuthorized'] is True,'Held recipe: execution not authorized'
 for key in ['inputPayloadSha256','inputPayloadReceiptSha256','actualNodeExecutableSha256','actualBunExecutableSha256','actualPnpmEntrySha256','gridReferenceSha256']:
  assert isinstance(p.get(key),str) and re.fullmatch('[a-f0-9]{64}',p[key]),'Missing actual pin: '+key
 assert p['sourceCommit']==COMMIT and p['sourceTree']==TREE
 assert p['observerDefaultBatchMs']==32 and p['nativeDefaultEnabled'] is False
 assert p['retainedNativeSha256']=='4998ab3bde94e588a0c4ef300e0de657cfb39d7b0689f10627517a989b7fcaf7'
 assert isinstance(p.get('recipeHashes'),dict) and p['recipeHashes'],'Missing closed recipe hashes'
def contained(root,name):
 assert isinstance(name,str) and name and not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
 p=root/name;assert p.resolve().is_relative_to(root.resolve());return p
def unpack(archive,target,manifest):
 # Input-prep's link-free/hardlink-free payload contract; links created last.
 assert not target.exists();target.mkdir(mode=0o700)
 with tarfile.open(archive) as t:
  members=t.getmembers();assert len(members)<=200000 and sum(m.size for m in members)<=8*1024**3
  assert len({m.name for m in members})==len(members) and {m.name for m in members}==set(manifest)
  for m in members:
   p=contained(target,m.name);x=manifest[m.name]
   if x['kind']=='symlink':assert m.issym() and m.linkname==x['target'] and not pathlib.PurePosixPath(m.linkname).is_absolute();assert (p.parent/m.linkname).resolve().is_relative_to(target.resolve())
   elif x['kind']=='directory':assert m.isdir() and (m.mode&0o777)==x['mode']
   else:assert x['kind']=='file' and m.isfile() and m.size==x['size'] and (m.mode&0o777)==x['mode']
  for m in members:
   if m.issym():continue
   p=contained(target,m.name)
   if m.isdir():p.mkdir(parents=True,exist_ok=True);p.chmod(m.mode&0o777)
   else:
    p.parent.mkdir(parents=True,exist_ok=True)
    with t.extractfile(m) as src,p.open('xb') as dst:shutil.copyfileobj(src,dst)
    p.chmod(m.mode&0o777);os.utime(p,(m.mtime,m.mtime));assert sha(p)==manifest[m.name]['sha256']
  for m in members:
   if m.issym():p=contained(target,m.name);p.parent.mkdir(parents=True,exist_ok=True);p.symlink_to(m.linkname)
 for name,x in manifest.items():
  if x['kind']=='symlink':assert contained(target,name).resolve(strict=True).is_relative_to(target.resolve())
def verify_input(root,manifest):
 for name,x in manifest.items():
  p=contained(root,name)
  if x['kind']=='symlink':assert p.is_symlink() and os.readlink(p)==x['target'] and p.resolve(strict=True).is_relative_to(root.resolve())
  else:
   assert not p.is_symlink() and stat.S_IMODE(p.stat().st_mode)==x['mode']
   if x['kind']=='file':assert p.is_file() and sha(p)==x['sha256']
   else:assert p.is_dir()
