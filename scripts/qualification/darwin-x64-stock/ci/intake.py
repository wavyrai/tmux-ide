"""Admit exact accepted CI ZIP and extract only closed preparation payload files."""
import json,pathlib,zipfile,shutil,sys
from admission import sha

def intake(metadata,archive,out,pins):
 m=json.loads(metadata.read_text());assert m['id']==pins['acceptedInputArtifactId'] and m['workflow_run']['id']==36607482309
 assert m['name']=='darwin-x64-performance-inputs-36607482309-1' and not m['expired']
 assert m['digest']=='sha256:'+pins['acceptedInputArtifactDigest'] and sha(archive)==pins['acceptedInputArtifactDigest']
 assert archive.stat().st_size==553524500;out.mkdir(mode=0o700)
 with zipfile.ZipFile(archive) as z:
  names=z.namelist();assert len(names)==len(set(names))
  for name,key in [('inputs.tar.gz','inputPayloadSha256'),('payload-manifest.json','inputPayloadReceiptSha256')]:
   entry=z.getinfo('darwin-x64-inputs/'+name);assert entry.file_size<=1024**3 and not entry.is_dir()
   target=out/name
   with z.open(entry) as src,target.open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
   assert sha(target)==pins[key]
if __name__=='__main__':
 metadata,archive,out,pins=map(pathlib.Path,sys.argv[1:]);intake(metadata,archive,out,json.loads(pins.read_text()))
