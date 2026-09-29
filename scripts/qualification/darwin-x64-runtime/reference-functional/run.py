"""Explicit reference-only four-case prerequisite, separate from performance and native qualification."""
import pathlib,json,os,sys,subprocess,signal,importlib.util,time
spec=importlib.util.spec_from_file_location('reference_prepare',pathlib.Path(__file__).with_name('prepare.py'));preparation=importlib.util.module_from_spec(spec);spec.loader.exec_module(preparation);prepare=preparation.prepare

def run(binding_path,admission_path,runtime_recipe,output):
 recipe=pathlib.Path(runtime_recipe).resolve();sys.path.insert(0,str(recipe));from binding import bind_runtime
 a=json.loads(pathlib.Path(admission_path).read_text())
 def verify():return bind_runtime(a['root'],a['zip'],a['tar'],a['proof'],a['pins'],a['referenceRoot'])
 b=verify();assert b==json.loads(pathlib.Path(binding_path).read_text())
 output=pathlib.Path(output).resolve();receipt=prepare(b,output);(output/'preparation.json').write_text(json.dumps(receipt,indent=2))
 p=b['paths'];env={'HOME':str(output/'home'),'TMPDIR':str(output/'temp'),'PATH':str(pathlib.Path(p['node']).parent)+':/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'en_US.UTF-8','TZ':'UTC','TMUX_IDE_NATIVE_GRID_TMUX':p['reference']}
 code=None;cleanup=None;post=False;timedout=False
 try:
  command=[p['node'],str(pathlib.Path(p['source'])/'node_modules/vitest/vitest.mjs'),'run','--config',str(output/'vitest.config.mjs'),'--reporter=json','--outputFile',str(output/'vitest.json')]
  with (output/'vitest.log').open('xb') as log:
   child=subprocess.Popen(command,cwd=output,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   try:code=child.wait(timeout=90)
   except subprocess.TimeoutExpired:
    timedout=True;os.killpg(child.pid,signal.SIGTERM)
    try:code=child.wait(timeout=10)
    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);code=child.wait(timeout=5)
 finally:
  try:
   with (output/'cleanup.log').open('xb') as log:cleanup=subprocess.run([p['bun'],str(output/'cleanup.mjs')],cwd=output,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=120).returncode
  finally:
   try:verify();post=True
   finally:(output/'terminal.json').write_text(json.dumps({'exit':code,'timedout':timedout,'cleanupExit':cleanup,'postclosure':post,'nativeMatrixRerun':False,'referenceSha256':receipt['referenceSha256']},indent=2))
 assert code==0 and not timedout and cleanup==0 and post,'Reference prerequisite failed; no performance'
 result=json.loads((output/'vitest.json').read_text())
 assert result['success'] is True and result['numTotalTests']==result['numPassedTests']==4 and result['numFailedTests']==result['numPendingTests']==0
 owners=[json.loads(p.read_text()) for p in (output/'receipts').glob('*.json')]
 assert len(owners)==4 and all(x['cleanup']['retired'] is True for x in owners),'Missing owned cleanup proof'
 (output/'accepted.json').write_text(json.dumps({'passed':True,'cases':4,'skipped':0,'referenceSha256':receipt['referenceSha256'],'cleanup':True,'prepostFullAdmission':True,'scope':'Existing allocated backing/paint oracle only; no journal/sanitizer/performance'}))
if __name__=='__main__':
 assert sys.argv[1]=='--approved-reference-check'
 run(*sys.argv[2:])
