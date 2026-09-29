"""Closed single lane: admit, prepare readers, freeze, verify, run. Pins remain held."""
import pathlib,json,sys,os,time,shutil,importlib.util
from binding import sha,bind_runtime
from stage import stage_sources
BASE=pathlib.Path(__file__).resolve().parent

def load(name):
 s=importlib.util.spec_from_file_location(name.replace('-','_'),BASE/(name+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def run(lane,output):
 assert lane in ['parser','metadata','tail'];output=pathlib.Path(output).resolve();assert not output.exists();output.mkdir(mode=0o700)
 pins=json.loads((BASE/'pins-components.json').read_text());assert pins['executionAuthorized'] is True and pins['authorizedLane']==lane,'Held component lane'
 assert pins['matchedReference'] is not None,'Matched reference prerequisite remains held'
 for rel,h in json.loads((BASE/'recipe-files-components.json').read_text()).items():assert sha(BASE/rel)==h,rel
 prerequisite=load('component-prerequisite').admit(pins,BASE)
 status={'referenceFunctionalPrerequisite':prerequisite,'ok':False,'lane':lane,'phase':'admission','noRetry':True,'runtimePatch':None};(output/'status.json').write_text(json.dumps(status))
 try:
  shared=load('runner');intake=load('intake-cpu').intake
  runtime_zip=shared.download(pins,output/'runtime-download');runtime=intake(runtime_zip,pins,output/'runtime-transport')
  ref=pins['matchedReference'];ref_zip=shared.download(ref,output/'reference-download');reference=intake(ref_zip,ref,output/'reference-transport')
  ref=dict(ref,zipRelativePath=str(ref_zip),tarRelativePath=str(output/'reference-transport/payload.tar'),proofRelativePath=str(output/'reference-transport/payload-proof.json'))
  pins=dict(pins,matchedReference=ref)
  admission={'root':str(runtime),'zip':str(runtime_zip),'tar':str(output/'runtime-transport/payload.tar'),'proof':str(output/'runtime-transport/payload-proof.json'),'pins':pins,'referenceRoot':str(reference)}
  binding=bind_runtime(admission['root'],admission['zip'],admission['tar'],admission['proof'],pins,reference)
  overlay=output/'overlay';stage_sources(binding,overlay)
  bp=output/'binding.json';bp.write_text(json.dumps(binding,indent=2));ap=output/'admission.json';ap.write_text(json.dumps(admission,indent=2))
  status['phase']='reader-preparation';frozen=output/'lane';load('freeze-component').freeze(lane,bp,ap,overlay,frozen)
  spec=frozen/'frozen-component.json';auth=output/'authorization.json';auth.write_text(json.dumps({'executionAuthorized':True,'lane':lane,'sourceCommit':pins['sourceCommit'],'frozenSpecSha256':sha(spec),'ciHead':os.environ.get('GITHUB_SHA'),'ciRun':os.environ.get('GITHUB_RUN_ID')}))
  status['phase']='original-lane';load('run-component').run(spec,auth);status.update(ok=True,phase='complete')
 finally:
  status['finished']=time.time();(output/'status.json').write_text(json.dumps(status,indent=2));evidence=output/'evidence';evidence.mkdir(exist_ok=True)
  for name in ['status.json','binding.json','admission.json','authorization.json']:
   if (output/name).exists():shutil.copyfile(output/name,evidence/name)
  if (output/'lane').exists():shutil.copytree(output/'lane',evidence/'lane',ignore=shutil.ignore_patterns('home'),dirs_exist_ok=True)
  if (output/'overlay').exists():shutil.copytree(output/'overlay',evidence/'overlay',ignore=shutil.ignore_patterns('node_modules','__pycache__'),dirs_exist_ok=True)
  for name in ['runtime-download','reference-download']:
   if (output/name/'metadata.json').exists():shutil.copyfile(output/name/'metadata.json',evidence/(name+'.json'))
if __name__=='__main__':run(*sys.argv[1:])
