"""Offline admission/binding only. No command execution, extraction, build or workload."""
import hashlib,json,os,pathlib,stat

SOURCE='c95f246ae4a87e86f5299a4d3b594f086f2333f2'
OBSERVER='25fe499de80614c77679b3634c4afb83f81d47e906e71c22d2b5194a1df57158'
NATIVE='4998ab3bde94e588a0c4ef300e0de657cfb39d7b0689f10627517a989b7fcaf7'
ROOTS=['source','admitted','recipe','binding.json','cli-receipt.json','host-tools.json']

def sha(path):
 h=hashlib.sha256()
 with pathlib.Path(path).open('rb') as f:
  for part in iter(lambda:f.read(1024*1024),b''):h.update(part)
 return h.hexdigest()

def closed_path(root,relative):
 root=pathlib.Path(root).resolve(strict=True);p=pathlib.PurePosixPath(relative)
 assert relative and not p.is_absolute() and '..' not in p.parts and str(p)==relative,'Unsafe relative path'
 target=root/pathlib.Path(relative)
 assert target.resolve(strict=True).is_relative_to(root),'Escaping payload path'
 return target

def rebind(root,old_root,path):
 old=pathlib.PurePosixPath(path);prefix=pathlib.PurePosixPath(old_root)
 assert old.is_absolute() and old.is_relative_to(prefix),'Unbound archived path'
 return str(closed_path(root,str(old.relative_to(prefix))))

def verify_tree(root,ledger,roots=ROOTS):
 root=pathlib.Path(root).resolve(strict=True)
 assert ledger and isinstance(ledger,dict)
 actual=set()
 for name in roots:
  p=root/name
  assert p.exists() and not p.is_symlink(),'Missing payload root'
  actual.add(name)
  if p.is_dir():actual.update(str(q.relative_to(root)) for q in p.rglob('*'))
 assert actual==set(ledger),'Payload member set differs'
 for rel,row in ledger.items():
  p=closed_path(root,rel);s=p.lstat()
  assert stat.S_IMODE(s.st_mode)==row['mode'],('mode',rel)
  if row['kind']=='file':assert stat.S_ISREG(s.st_mode) and s.st_size==row['bytes'] and sha(p)==row['sha256'],('bytes',rel)
  elif row['kind']=='dir':assert stat.S_ISDIR(s.st_mode),rel
  elif row['kind']=='link':
   assert stat.S_ISLNK(s.st_mode) and os.readlink(p)==row['target'] and not os.path.isabs(row['target']),rel
   assert str(p.resolve(strict=True).relative_to(root)) in ledger,('unlisted link target',rel)
  else:raise AssertionError('Unsupported member kind')
 return len(ledger)

def validate_receipts(binding,receipt,pins):
 assert binding['sourceCommit']==receipt['sourceCommit']==SOURCE
 assert binding['sourceTree']==receipt['sourceTree']==pins['sourceTree']
 assert binding['observerSourceSha256']==OBSERVER
 assert binding['observerDefaultBatchMs']==receipt['observerDefaultBatchMs']==32
 assert binding['nativeDefaultEnabled'] is receipt['nativeDefaultEnabled'] is False
 assert binding['retainedNativeSha256']==NATIVE
 assert receipt['nodePtyLoaded'] is True and receipt['fixturesStarted'] is False
 assert receipt['performanceQualified'] is False
 assert receipt['cliSha256']==pins['cliSha256'] and len(pins['cliSha256'])==64
 assert pins['matchedReference'] is not None,'Matched reference not admitted'
 assert pins['matchedReference']['accepted'] is True
 assert pins['matchedReference']['nativeSha256']==NATIVE
 assert pins['matchedReference']['libraryBytesMatchNative'] is True
 assert pins['matchedReference']['journalPatch'] is None

def bind_runtime(root,zip_path,tar_path,proof_path,pins,reference_root,derivation=None):
 """Full actual ZIP/tar/member verification precedes binding, independently of local download."""
 for key in ['cliSha256','payloadProofSha256','cliReceiptSha256','matchedReference']:
  assert pins.get(key) is not None,('Unclosed pin',key)
 root=pathlib.Path(root).resolve(strict=True)
 assert sha(zip_path)==pins['zipSha256'] and pathlib.Path(zip_path).stat().st_size==pins['zipBytes']
 assert sha(tar_path)==pins['tarSha256'] and pathlib.Path(tar_path).stat().st_size==pins['tarBytes']
 assert sha(proof_path)==pins['payloadProofSha256']
 proof=json.loads(pathlib.Path(proof_path).read_text())
 assert proof['roundtripVerified'] is True and proof['gitIncluded'] is True and proof['absoluteSymlinksAllowed'] is False
 assert len(proof['ledger'])==proof['members']
 if derivation is None:count=verify_tree(root,proof['ledger'])
 else:
  from derived_runtime import verify as verify_derived
  count=verify_derived({'root':str(root),'zip':str(zip_path),'tar':str(tar_path),'proof':str(proof_path),'pins':pins},derivation,verify_tree)['members']
 assert sha(root/'cli-receipt.json')==pins['cliReceiptSha256']
 binding=json.loads((root/'binding.json').read_text());receipt=json.loads((root/'cli-receipt.json').read_text())
 validate_receipts(binding,receipt,pins)
 old_root=str(pathlib.PurePosixPath(receipt['cli']).parents[3])
 assert receipt['cli']==old_root+'/source/.tasks/qualified-cli/cli.mjs','Unexpected actual CLI layout'
 paths={name:rebind(root,old_root,binding[name]) for name in ['node','bun','pnpm','native']}
 paths.update(source=str(root/'source'),cli=rebind(root,old_root,receipt['cli']))
 for key,pin in [('node','actualNodeExecutableSha256'),('bun','actualBunExecutableSha256'),('pnpm','actualPnpmEntrySha256')]:assert sha(paths[key])==binding[pin]
 assert sha(paths['native'])==NATIVE and sha(paths['cli'])==pins['cliSha256']
 assert sha(root/'source/packages/daemon/src/lib/native-tmux-interaction-observer.ts')==OBSERVER
 # Reference is independently fully admitted; it cannot come from CLI's old unmatched grid-reference.
 ref=pins['matchedReference'];reference_root=pathlib.Path(reference_root).resolve(strict=True)
 assert sha(reference_root/ref['zipRelativePath'])==ref['zipSha256']
 assert sha(reference_root/ref['tarRelativePath'])==ref['tarSha256']
 assert sha(reference_root/ref['proofRelativePath'])==ref['proofSha256']
 rp=json.loads((reference_root/ref['proofRelativePath']).read_text())
 assert rp['roundtripVerified'] is True and rp['sha256']==ref['tarSha256']
 assert len(rp['ledger'])==rp['members']
 # Existing matched-reference recipe package roots; verifies actual extracted bytes, modes, links.
 reference_count=verify_tree(reference_root,rp['ledger'],['reference/bundle','reference/mach-closure.json','reference/build-tools.json','reference/status.json','reference/stages.json','downloads.json'])
 paths['reference']=str(closed_path(reference_root,ref['binaryRelativePath']))
 assert sha(paths['reference'])==ref['binarySha256']
 native_lib=pathlib.Path(paths['native']).parent/'lib';reference_lib=pathlib.Path(paths['reference']).parent/'lib'
 native_names={p.name for p in native_lib.iterdir() if p.is_file()}
 reference_names={p.name for p in reference_lib.iterdir() if p.is_file()}
 assert native_names==reference_names and len(native_names)==3,'Matched dylib set differs'
 for name in native_names:assert sha(native_lib/name)==sha(reference_lib/name),('Matched dylib bytes differ',name)
 return {'executionAuthorized':False,'sourceCommit':SOURCE,'observerSha256':OBSERVER,'runtimePatch':None,'dependencyModeDerivation':derivation,'paths':paths,'payloadMembersVerified':count,'referenceMembersVerified':reference_count,'fullZipTarMembersVerified':True,'archivedHost':receipt['hostTools'],'freshHost':None,'closure':None,'archiveRoot':str(root),'referenceRoot':str(reference_root),'originalReceiptSha256':pins['cliReceiptSha256']}
