"""Closed coherence admission. Reuses full accepted member verification; starts no process."""
import pathlib,json,importlib.util
import derived_runtime
HERE=pathlib.Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('accepted_binding',HERE/'upstream-binding.py');u=importlib.util.module_from_spec(s);s.loader.exec_module(u)
sha=u.sha

def archive(root,zip_path,tar_path,proof_path,pin,roots):
 root=pathlib.Path(root).resolve(strict=True)
 for path,digest,size in [(zip_path,pin['zipSha256'],pin['zipBytes']),(tar_path,pin['tarSha256'],pin['tarBytes'])]:
  assert sha(path)==digest and pathlib.Path(path).stat().st_size==size
 assert sha(proof_path)==pin['payloadProofSha256']
 proof=json.loads(pathlib.Path(proof_path).read_text());assert proof['roundtripVerified'] is True
 # CLI proof has no embedded tar digest; stock proof does. Both are byte-pinned above.
 if 'sha256' in proof:assert proof['sha256']==pin['tarSha256']
 assert len(proof['ledger'])==proof['members']
 return u.verify_tree(root,proof['ledger'],roots)

def bind(runtime,stock,pins,derivation=None):
 assert pins['sourceCommit']==u.SOURCE and pins['stock'] is not None
 root=pathlib.Path(runtime['root']).resolve(strict=True)
 count=(archive(root,runtime['zip'],runtime['tar'],runtime['proof'],pins,u.ROOTS) if derivation is None else derived_runtime.verify(dict(runtime,pins=pins),derivation,u.verify_tree)['members'])
 receipt=json.loads((root/'cli-receipt.json').read_text());b=json.loads((root/'binding.json').read_text())
 assert sha(root/'cli-receipt.json')==pins['cliReceiptSha256']
 assert b['sourceCommit']==receipt['sourceCommit']==u.SOURCE
 assert b['sourceTree']==receipt['sourceTree']==pins['sourceTree']
 assert b['observerSourceSha256']==u.OBSERVER
 assert b['observerDefaultBatchMs']==receipt['observerDefaultBatchMs']==32
 assert b['nativeDefaultEnabled'] is receipt['nativeDefaultEnabled'] is False
 assert b['retainedNativeSha256']==u.NATIVE
 assert receipt['nodePtyLoaded'] is True and receipt['fixturesStarted'] is False and receipt['performanceQualified'] is False
 assert receipt['cliSha256']==pins['cliSha256']
 old=str(pathlib.PurePosixPath(receipt['cli']).parents[3]);assert receipt['cli']==old+'/source/.tasks/qualified-cli/cli.mjs'
 paths={k:u.rebind(root,old,b[k]) for k in ['node','bun','pnpm','native']}
 paths.update(source=str(root/'source'),cli=u.rebind(root,old,receipt['cli']))
 for k,p in [('node','actualNodeExecutableSha256'),('bun','actualBunExecutableSha256'),('pnpm','actualPnpmEntrySha256')]:assert sha(paths[k])==b[p]
 assert sha(paths['cli'])==pins['cliSha256'] and sha(paths['native'])==u.NATIVE
 assert sha(root/'source/packages/daemon/src/lib/native-tmux-interaction-observer.ts')==u.OBSERVER
 sp=pins['stock'];sr=pathlib.Path(stock['root']).resolve(strict=True)
 sn=archive(sr,stock['zip'],stock['tar'],stock['proof'],sp,sp['payloadRoots'])
 paths['stock']=str(u.closed_path(sr,sp['binaryRelativePath']));assert sha(paths['stock'])==sp['binarySha256']
 manifest=json.loads(u.closed_path(sr,sp['manifestRelativePath']).read_text())
 assert sha(u.closed_path(sr,sp['manifestRelativePath']))==sp['manifestSha256']
 assert manifest['kind']=='stock-tmux' and manifest['capabilityAdmissionPending'] is True
 assert manifest['expectedCapabilities']=={'nativeGrid':False,'journal':False}
 assert manifest['mode'] in ['host-stock','unpatched-source']
 assert manifest['patches']==([] if manifest['mode']=='unpatched-source' else None)
 status=json.loads((sr/'stock/status.json').read_text());assert status['ok'] is True and status['performanceQualified'] is False and status['native4998Rebuilt'] is False
 return {'executionAuthorized':False,'sourceCommit':u.SOURCE,'sourceTree':pins['sourceTree'],'paths':paths,'archiveRoot':str(root),'stockRoot':str(sr),'runtimeMembers':count,'stockMembers':sn,'observerDefaultBatchMs':32,'noRebuild':True,'stockManifest':manifest,'runtimePatch':None,'dependencyModeDerivation':derivation}
