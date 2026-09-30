import pathlib,json,tempfile,unittest,importlib.util,types,hashlib,sys
from unittest.mock import patch
BASE=pathlib.Path(__file__).resolve().parent

def load(name):
 s=importlib.util.spec_from_file_location(name.replace('-','_'),BASE/(name+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

class Components(unittest.TestCase):
 def test_actual_descriptors_bind_explicit_verifier_and_reference(self):
  freeze=load('freeze-component')
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);overlay=root/'overlay';out=root/'out';out.mkdir();(overlay/'metadata').mkdir(parents=True);source=overlay/'metadata/metadata.py';source.write_text('original')
   freeze.write_descriptors('metadata',overlay,out,'/explicit/python',{'binary':'/admitted/reference','sha256':'r'*64})
   directory=overlay/'metadata';verifier=(directory/'verify.mjs').read_text()
   self.assertIn('/explicit/python',verifier);self.assertIn(str(out/'frozen-component.json'),verifier);self.assertIn(str(BASE/'verify-cpu.py'),verifier)
   self.assertEqual(json.loads((directory/'reference.json').read_text())['binary'],'/admitted/reference')
   hashes=json.loads((directory/'source-at-prepare.json').read_text())['hashes'];self.assertEqual(hashes[str(source)],hashlib.sha256(b'original').hexdigest());self.assertNotIn(str(directory/'source-at-prepare.json'),hashes)
 def test_commands_preserve_original_lane_workloads(self):
  run=load('run-component');s={'node':'/node','python':'/python','overlay':'/overlay','binary':'/native','output':'/results'}
  self.assertEqual(run.command(dict(s,lane='metadata'))[-2:],['/overlay/metadata/metadata.py','--approved-metadata'])
  self.assertEqual(run.command(dict(s,lane='tail'))[-2:],['/overlay/tail/tail_backlog.py','--approved-tail-backlog'])
  self.assertEqual(run.command(dict(s,lane='parser'))[-4:],['/overlay/parser/echo.mjs','/native','/results','qualification'])
 def test_wrapper_failure_still_verifies_and_never_accepts_uncertain_cleanup(self):
  for exitcode,uncertain in [(0,False),(1,False),(0,True)]:
   m=load('run-component')
   with tempfile.TemporaryDirectory() as t:
    root=pathlib.Path(t);overlay=root/'overlay';(overlay/'tail').mkdir(parents=True);home=root/'home';home.mkdir();spec=root/'frozen.json';data={'lane':'tail','sourceCommit':'c95','node':'/node','python':'/python','binary':'/native','overlay':str(overlay),'output':str(overlay/'tail'),'cleanHome':str(home),'verifyScript':'unused'};spec.write_text(json.dumps(data));auth=root/'auth.json';auth.write_text(json.dumps({'executionAuthorized':True,'lane':'tail','sourceCommit':'c95','frozenSpecSha256':hashlib.sha256(spec.read_bytes()).hexdigest()}))
    calls=[]
    def verify(path):calls.append(path);return {'ok':True}
    rows=[{'cleanup':[{'absenceProved':True}]+([{'error':'uncertain'}] if uncertain else [])} for _ in range(3)]
    class Child:
     def __init__(self,*a,**kw):
      self.env=kw['env'];(overlay/'tail/tail-backlog-results.json').write_text(json.dumps({'runs':rows}))
     def wait(self):return exitcode
    with patch.object(m,'load',return_value=types.SimpleNamespace(verify=verify)),patch.object(m.subprocess,'Popen',Child),patch.object(m,'validate',return_value={'passed':True}):
     if exitcode or uncertain:
      with self.assertRaises(SystemExit):m.run(spec,auth)
     else:m.run(spec,auth)
    self.assertEqual(len(calls),2);terminal=json.loads((root/'terminal.json').read_text());self.assertEqual(terminal['passed'],not(exitcode or uncertain));self.assertTrue(terminal['postclosure'])
 def test_python_cancel_enters_original_finally_without_second_interrupt(self):
  import subprocess,os
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);marker=root/'cleaned';entry=root/'driver.py'
   entry.write_text("import os,signal,pathlib\ntry:\n os.kill(os.getpid(),signal.SIGTERM)\nfinally:\n os.kill(os.getpid(),signal.SIGTERM)\n pathlib.Path("+repr(str(marker))+").write_text('retired')\n")
   result=subprocess.run([sys.executable,str(BASE/'component-python.py'),str(entry)],capture_output=True,timeout=5,env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'))
   self.assertNotEqual(result.returncode,0);self.assertEqual(marker.read_text(),'retired')
 def test_exact_reference_prerequisite_receipt_and_negatives(self):
  m=load('component-prerequisite')
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);p=root/'reference-functional-accepted.json';receipt={'passed':True,'cases':4,'skipped':0,'cleanup':True,'prepostFullAdmission':True,'referenceSha256':'a'*64};p.write_text(json.dumps(receipt))
   pins={'matchedReference':{'binarySha256':'a'*64},'referenceFunctionalReceipt':{'file':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'runId':123}}
   self.assertFalse(m.admit(pins,root)['rerun'])
   for key,value in [('passed',False),('cases',3),('skipped',1),('cleanup',False),('prepostFullAdmission',False),('referenceSha256','b'*64)]:
    changed=dict(receipt,**{key:value});p.write_text(json.dumps(changed));pins['referenceFunctionalReceipt']['sha256']=hashlib.sha256(p.read_bytes()).hexdigest()
    with self.assertRaises(AssertionError):m.admit(pins,root)
   p.write_text(json.dumps(receipt));pins['referenceFunctionalReceipt']['sha256']=None
   with self.assertRaisesRegex(AssertionError,'unpinned'):m.admit(pins,root)
   pins['referenceFunctionalReceipt']['sha256']='0'*64
   with self.assertRaisesRegex(AssertionError,'changed'):m.admit(pins,root)
 def test_shared_verifier_threads_frozen_derivation(self):
  m=load('verify-cpu')
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);host=root/'host.json';host.write_text(json.dumps({'boot':'boot','os':'os','tools':{},'mach':{'files':{},'systemFiles':{}},'resolutions':{}}))
   derivation={'receipt':'/closed/receipt','receiptSha256':'a'*64,'ledger':'/closed/ledger','ledgerSha256':'b'*64}
   admission={'root':'/runtime','zip':'/zip','tar':'/tar','proof':'/proof','pins':{},'referenceRoot':'/reference','derivation':derivation}
   spec=root/'spec.json';spec.write_text(json.dumps({'admission':admission,'closure':{},'links':{},'hostReceipt':str(host)}))
   def output(argv,**kwargs):
    return 'x86_64' if argv[0]=='/usr/bin/uname' else 'os' if argv[0]=='/usr/bin/sw_vers' else 'boot' if argv[-1]=='kern.boottime' else '0'
   with patch.object(m,'bind_runtime') as bind,patch.object(m.subprocess,'check_output',side_effect=output):m.verify(spec)
   self.assertEqual(bind.call_args.args[-1],derivation)
 def test_actual_accepted_reference_receipt_is_admitted_for_selected_lane(self):
  pins=json.loads((BASE/'pins-components.json').read_text())
  self.assertIsInstance(pins['executionAuthorized'],bool);self.assertEqual(pins['authorizedLane'],'parser')
  receipt=load('component-prerequisite').admit(pins,BASE)
  self.assertEqual(receipt['runId'],36680179337);self.assertEqual(receipt['cases'],4)
 def test_held_runner_refuses_before_transport(self):
  with tempfile.TemporaryDirectory() as t,patch('subprocess.run') as command:
   root=pathlib.Path(t);recipe=root/'recipe';recipe.mkdir();pins=json.loads((BASE/'pins-components.json').read_text());pins['executionAuthorized']=False;(recipe/'pins-components.json').write_text(json.dumps(pins))
   runner=load('runner-component');runner.BASE=recipe
   with self.assertRaisesRegex(AssertionError,'Held component'):runner.run('parser',root/'out')
   command.assert_not_called()
if __name__=='__main__':unittest.main()
