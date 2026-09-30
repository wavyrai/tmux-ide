"""One closed hosted CPU envelope; no native/reference/CLI build, install or retries."""
import pathlib,json,subprocess,os,sys,time,shutil,importlib.util,stat
from binding import sha,bind_runtime,verify_tree
from stage import stage_sources
BASE=pathlib.Path(__file__).resolve().parent

def module(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def collect_reference_evidence(source,destination):
 source=pathlib.Path(source);destination=pathlib.Path(destination);skipped=[]
 def exclude(directory,names):
  ignored=[]
  for name in names:
   path=pathlib.Path(directory)/name
   if name in ('node_modules','cache','home'):ignored.append(name);continue
   mode=path.lstat().st_mode
   if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
    ignored.append(name);kind='socket' if stat.S_ISSOCK(mode) else 'symlink' if stat.S_ISLNK(mode) else 'fifo' if stat.S_ISFIFO(mode) else 'special'
    skipped.append({'path':str(path.relative_to(source)),'type':kind,'mode':stat.S_IMODE(mode)})
  return ignored
 try:shutil.copytree(source,destination,ignore=exclude,dirs_exist_ok=True)
 finally:
  destination.mkdir(parents=True,exist_ok=True)
  (destination/'collection-diagnostics.json').write_text(json.dumps({'skippedSpecialPaths':skipped,'cleanupInferred':False,'sourcePathsDeleted':False},indent=2))

def download(pin,directory):
 directory.mkdir(mode=0o700)
 for endpoint,name in [(str(pin['artifactId']),'metadata.json'),(str(pin['artifactId'])+'/zip','artifact.zip')]:
  with (directory/name).open('xb') as out,(directory/(name+'.stderr')).open('xb') as err:
   subprocess.run(['gh','api','repos/wavyrai/tmux-ide/actions/artifacts/'+endpoint],stdout=out,stderr=err,check=True,timeout=1200)
  if name=='metadata.json':
   m=json.loads((directory/name).read_text());assert m['id']==pin['artifactId'] and m['workflow_run']['id']==pin['runId'] and not m['expired']
   assert m['size_in_bytes']==pin['zipBytes'] and m['digest']=='sha256:'+pin['zipSha256']
 assert sha(directory/'artifact.zip')==pin['zipSha256']
 return directory/'artifact.zip'

def run(output):
 output=pathlib.Path(output).resolve();assert not output.exists();output.mkdir(mode=0o700)
 pins=json.loads((BASE/'pins.json').read_text());assert pins['executionAuthorized'] is True,'Held source: no CPU authorization'
 assert pins['matchedReference'] is not None,'Matched reference pins remain open'
 manifest=json.loads((BASE/'recipe-files.json').read_text())
 for rel,d in manifest.items():assert sha(BASE/rel)==d,('Recipe changed',rel)
 status={'started':time.time(),'ok':False,'runtimePatch':None,'noRetry':True};(output/'status.json').write_text(json.dumps(status))
 try:
  prerequisite=module('reference_prerequisite',BASE/'reference-prerequisite.py').admit(pins,BASE)
  (output/'reference-prerequisite.json').write_text(json.dumps(prerequisite,indent=2))
  shutil.copyfile(BASE/pins['referenceFunctionalReceipt']['file'],output/'reference-functional-accepted.json')
  intake=module('cpu_intake',BASE/'intake-cpu.py').intake
  runtime_zip=download(pins,output/'runtime-download');runtime=intake(runtime_zip,pins,output/'runtime-transport')
  ref=pins['matchedReference'];ref_zip=download(ref,output/'reference-download');reference=intake(ref_zip,ref,output/'reference-transport')
  # Reference pin paths address the fresh intake's external transport and payload, never old host paths.
  ref=dict(ref,zipRelativePath=str(ref_zip),tarRelativePath=str(output/'reference-transport/payload.tar'),proofRelativePath=str(output/'reference-transport/payload-proof.json'))
  pins=dict(pins,matchedReference=ref)
  admission={'root':str(runtime),'zip':str(runtime_zip),'tar':str(output/'runtime-transport/payload.tar'),'proof':str(output/'runtime-transport/payload-proof.json'),'pins':pins,'referenceRoot':str(reference)}
  admission['dependencyModeDerivation']=module('derived_runtime',BASE/'derived_runtime.py').prepare(admission,output/'runtime-derivation',verify_tree)
  binding=bind_runtime(admission['root'],admission['zip'],admission['tar'],admission['proof'],pins,reference,admission['dependencyModeDerivation'])
  accepted=output/'reference-functional-accepted.json'
  binding['referenceFunctional']={'referenceSha256':ref['binarySha256'],'originRunId':prerequisite['runId'],'files':{str(accepted):sha(accepted)}}
  binding_path=output/'binding.json';binding_path.write_text(json.dumps(binding,indent=2));admission_path=output/'admission.json';admission_path.write_text(json.dumps(admission,indent=2))
  overlay=output/'overlay';stage_sources(binding,overlay)
  frozen=output/'cpu';module('cpu_freeze',BASE/'freeze-cpu.py').freeze(binding_path,admission_path,overlay,frozen)
  spec=frozen/'frozen-cpu.json';authorization=output/'authorization.json'
  authorization.write_text(json.dumps({'executionAuthorized':True,'lane':'cpu','sourceCommit':pins['sourceCommit'],'frozenSpecSha256':sha(spec),'recipeManifestSha256':sha(BASE/'recipe-files.json'),'ciHead':os.environ.get('GITHUB_SHA'),'ciRun':os.environ.get('GITHUB_RUN_ID')}))
  module('cpu_run',BASE/'run-cpu.py').run(spec,authorization,overlay)
  status['ok']=True
 finally:
  status['finished']=time.time();(output/'status.json').write_text(json.dumps(status,indent=2))
  # Upload only receipts and existing case outputs, never mutate/remove admitted inputs for closure.
  evidence=output/'evidence';evidence.mkdir(exist_ok=True)
  for name in ['status.json','binding.json','admission.json','authorization.json','reference-host.json','reference-host.log','reference-prerequisite.json','reference-functional-accepted.json']:
   if (output/name).exists():shutil.copyfile(output/name,evidence/name)
  if (output/'cpu').exists():shutil.copytree(output/'cpu',evidence/'cpu',ignore=shutil.ignore_patterns('home'),dirs_exist_ok=True)
  if (output/'reference-functional').exists():collect_reference_evidence(output/'reference-functional',evidence/'reference-functional')
  if (output/'runtime-derivation').exists():shutil.copytree(output/'runtime-derivation',evidence/'runtime-derivation',dirs_exist_ok=True)
  if (output/'overlay/binding.diff').exists():shutil.copyfile(output/'overlay/binding.diff',evidence/'binding.diff')
  for name in ['runtime-download','reference-download']:
   if (output/name/'metadata.json').exists():shutil.copyfile(output/name/'metadata.json',evidence/(name+'.json'))
if __name__=='__main__':run(sys.argv[1])
