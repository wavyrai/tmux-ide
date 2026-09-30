"""One declared node-pty preparation change; original archives/proof remain immutable."""
import hashlib,json,os,pathlib,stat
HELPER='source/node_modules/.pnpm/node-pty@1.2.0-beta.12/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper'
HELPER_SHA='a4e0a55cae569a094928909014af062979a9e9f4f2244485d7f74edf236195eb'
HELPER_BYTES=9248
ROOTS=['source','admitted','recipe','binding.json','cli-receipt.json','host-tools.json']

def sha(path):
 h=hashlib.sha256()
 with pathlib.Path(path).open('rb') as f:
  for part in iter(lambda:f.read(1024*1024),b''):h.update(part)
 return h.hexdigest()
def encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
def write_new(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())

def original(admission):
 root=pathlib.Path(admission['root']).resolve(strict=True);pins=admission['pins']
 for key,sizekey,hashkey in [('zip','zipBytes','zipSha256'),('tar','tarBytes','tarSha256')]:
  p=pathlib.Path(admission[key]);assert p.is_file() and p.stat().st_size==pins[sizekey] and sha(p)==pins[hashkey],('Original archive changed',key)
 proofpath=pathlib.Path(admission['proof']);assert sha(proofpath)==pins['payloadProofSha256'],'Original proof changed'
 proof=json.loads(proofpath.read_text());assert proof['roundtripVerified'] is True and proof['gitIncluded'] is True and proof['absoluteSymlinksAllowed'] is False
 assert len(proof['ledger'])==proof['members']
 row=proof['ledger'][HELPER]
 assert row=={'kind':'file','mode':0o700,'bytes':HELPER_BYTES,'sha256':HELPER_SHA},'Unexpected original helper identity or mode'
 ledger={name:dict(value) for name,value in proof['ledger'].items()};ledger[HELPER]['mode']=0o755
 binding={'zipSha256':pins['zipSha256'],'zipBytes':pins['zipBytes'],'tarSha256':pins['tarSha256'],'tarBytes':pins['tarBytes'],'payloadProofSha256':pins['payloadProofSha256']}
 return root,proof['ledger'],ledger,binding

def expected_receipt(root,binding,ledger):
 return {'version':1,'kind':'node-pty-darwin-x64-helper-mode','runtimeRoot':str(root),'original':binding,'derivedLedgerSha256':hashlib.sha256(encoded(ledger)).hexdigest(),'changes':[{'path':HELPER,'fromMode':0o700,'toMode':0o755,'bytes':HELPER_BYTES,'sha256':HELPER_SHA}],'productBytesChanged':False,'restoreAfterWorkload':False}

def prepare(admission,receipt_directory,verify_tree):
 """Caller passes the existing strict verify_tree. Must run before any product/fixture launch."""
 root,before,after,binding=original(admission)
 out=pathlib.Path(receipt_directory).resolve();assert not out.exists() and not out.is_relative_to(root),'Fresh receipt directory outside runtime required'
 # Initial actual extraction must match the ORIGINAL proof, including the original0700 mode.
 verify_tree(root,before,ROOTS)
 target=root/HELPER;assert target.resolve(strict=True)==target,'Helper path traverses a symlink'
 out.mkdir(mode=0o700,parents=False)
 fd=None
 try:
  fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW)
  witnessed=os.fstat(fd)
  assert stat.S_ISREG(witnessed.st_mode) and stat.S_IMODE(witnessed.st_mode)==0o700 and witnessed.st_size==HELPER_BYTES
  assert witnessed.st_uid==os.getuid() and witnessed.st_nlink==1,'Ambiguous helper ownership or hardlink aliases'
  with os.fdopen(os.dup(fd),'rb') as f:assert hashlib.sha256(f.read()).hexdigest()==HELPER_SHA
  current=target.lstat();assert (current.st_dev,current.st_ino)==(witnessed.st_dev,witnessed.st_ino)
  os.fchmod(fd,0o755)
  current=target.lstat();assert (current.st_dev,current.st_ino)==(witnessed.st_dev,witnessed.st_ino) and stat.S_IMODE(current.st_mode)==0o755
  verify_tree(root,after,ROOTS)
  # Rehash immutable inputs after derivation as well; never edit proof or original tar/ZIP.
  root2,_,after2,binding2=original(admission);assert root2==root and after2==after and binding2==binding
  ledger=out/'derived-ledger.json';receipt=out/'derivation.json'
  write_new(ledger,encoded(after));write_new(receipt,encoded(expected_receipt(root,binding,after)))
  return {'receipt':str(receipt),'receiptSha256':sha(receipt),'ledger':str(ledger),'ledgerSha256':sha(ledger)}
 except BaseException as e:
  # Uncertain partial preparation remains retained; never restore original mode to hide mutation.
  write_new(out/'failure.json',encoded({'failed':True,'error':repr(e)[:2048],'originalRestored':False}))
  raise
 finally:
  if fd is not None:os.close(fd)

def verify(admission,derivation,verify_tree):
 """Strict full original transport+proof and exact derived tree checks for every pre/post admission."""
 root,_,after,binding=original(admission)
 receipt=pathlib.Path(derivation['receipt']);ledger=pathlib.Path(derivation['ledger'])
 for p in [receipt,ledger]:
  st=p.lstat();assert stat.S_ISREG(st.st_mode) and not p.is_symlink() and st.st_uid==os.getuid() and stat.S_IMODE(st.st_mode)==0o600
  assert not p.resolve().is_relative_to(root),'Derivation evidence must stay outside runtime'
 assert sha(receipt)==derivation['receiptSha256'] and sha(ledger)==derivation['ledgerSha256'],'Derivation receipt changed'
 assert ledger.read_bytes()==encoded(after),'Derived ledger contains unapproved changes'
 assert receipt.read_bytes()==encoded(expected_receipt(root,binding,after)),'Derivation does not match exact input artifact/change'
 count=verify_tree(root,after,ROOTS)
 return {'originalArchiveProofVerified':True,'derivedTreeVerified':True,'members':count,'changes':expected_receipt(root,binding,after)['changes'],'receiptSha256':derivation['receiptSha256']}
