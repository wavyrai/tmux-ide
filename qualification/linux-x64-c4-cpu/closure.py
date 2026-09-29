"""Verify every prepared payload entry, including modes and relative symlinks."""
import hashlib,json,os,pathlib,stat
P=pathlib.Path
ROOTS=['source','native','native-grid-reference','host.json','host-inputs.json','artifact-receipt.json']
def sha(p):
 h=hashlib.sha256()
 with P(p).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def verify(work,ledger,allow_new_harness=False):
 work=P(work);expected={}
 for row in ledger['rows']:
  p=P(row['path'])
  if not p.is_relative_to('/work'):continue
  rel=p.relative_to('/work')
  if rel.parts and rel.parts[0] in ROOTS and '.git' not in rel.parts:expected[str(rel)]=row
 actual={}
 for name in ROOTS:
  root=work/name
  for p in [root,*root.rglob('*')] if root.is_dir() else [root]:actual[str(p.relative_to(work))]=p
 extras=set(actual)-set(expected)
 if allow_new_harness:
  extras-=set('source/.tasks/native-x64-c4/harness/'+n for n in ['campaign-cpu.py','cpu_environment.py','admit_topology.py'])
 assert not extras and not set(expected)-set(actual),('entry-set',list(extras)[:10])
 for rel,row in expected.items():
  p=actual[rel];assert stat.S_IMODE(p.lstat().st_mode)==row['mode'],('mode',rel)
  if row['kind']=='directory':assert p.is_dir() and not p.is_symlink()
  elif row['kind']=='symlink':
   assert p.is_symlink() and os.readlink(p)==row['target']
   assert not os.path.isabs(os.readlink(p)) and p.resolve().is_relative_to(work)
  else:assert p.is_file() and not p.is_symlink() and p.stat().st_size==row['bytes'] and sha(p)==row['sha256'],rel
 return {'entries':len(expected),'fileModeSymlinkClosureVerified':True}
