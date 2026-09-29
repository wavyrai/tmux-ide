"""Always-step continuation of exact-owned cleanup; no name-only deletion."""
import pathlib,os,json,subprocess
E=pathlib.Path(os.environ['RUNNER_TEMP'])/'x64-coherence-prep-evidence';intent=E/'owned-intent.json';base=['/usr/bin/docker','--host','unix:///var/run/docker.sock']
if intent.exists():
 d=json.loads(intent.read_text());r=subprocess.run(base+['ps','-a','--no-trunc','--filter','name=^/'+d['name']+'$','--format','{{.ID}}'],capture_output=True,text=True,timeout=30,check=True)
 ids=r.stdout.split();assert len(ids)<=1
 if ids:
  cid=ids[0];x=json.loads(subprocess.check_output(base+['inspect',cid],text=True,timeout=30))[0]
  assert x['Id']==cid and x['Name']=='/'+d['name'] and x['Image']==d['image'] and x['Config']['Labels']['tmux-ide.private-coherence-preparation']==d['nonce']
  (E/'cleanup-continuation-before.json').write_text(json.dumps(x,indent=2))
  subprocess.run(base+['rm','--force',cid],check=True,timeout=60)
 remaining=subprocess.check_output(base+['ps','-a','--no-trunc','--filter','name=^/'+d['name']+'$','--format','{{.ID}}'],text=True,timeout=30).strip();assert not remaining
 (E/'cleanup-continuation.json').write_text(json.dumps({'name':d['name'],'nonce':d['nonce'],'absenceConfirmed':True,'retired':ids}))
imageFile=E/'loaded-image.json'
if imageFile.exists():
 image=json.loads(imageFile.read_text())['imageId'];observed=json.loads(subprocess.check_output(base+['image','inspect',image],text=True,timeout=30))[0];assert observed['Id']==image
 subprocess.run(base+['image','rm',image],check=True,timeout=60)
 (E/'image-cleanup.json').write_text(json.dumps({'imageId':image,'removed':True}))
# Final artifact ledger includes this continuation's receipt, even after earlier failure.
if E.exists():
 import hashlib
 def digest(p):
  h=hashlib.sha256()
  with p.open('rb') as f:
   for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
  return h.hexdigest()
 (E/'artifact-hashes.json').write_text(json.dumps({str(p.relative_to(E)):digest(p) for p in sorted(E.rglob('*')) if p.is_file() and p!=E/'artifact-hashes.json'},indent=2))
