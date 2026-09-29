import unittest,pathlib,tempfile,json,importlib.util,signal,sys,types,ast,io,os
from unittest.mock import patch
BASE=pathlib.Path(__file__).resolve().parent

def module(name):
 spec=importlib.util.spec_from_file_location(name.replace('-','_'),BASE/(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

class EnvelopeTests(unittest.TestCase):
 def test_tar_symlink_escape_rejected_before_file_extraction(self):
  import tarfile
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);archive=root/'x.tar';m=tarfile.TarInfo('x');m.type=tarfile.SYMTYPE;m.linkname='../escape';m.mode=0o777
   with tarfile.open(archive,'w') as out:out.addfile(m)
   with self.assertRaises(AssertionError):module('intake-cpu').extract_tar(archive,root/'payload',{'x':{'kind':'link','target':'../escape','mode':0o777}})
   self.assertFalse((root/'escape').exists())
 def test_tar_hardlink_materialized_and_tampered_pin_refused(self):
  import tarfile,hashlib
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);archive=root/'x.tar';row={'kind':'file','mode':0o600,'bytes':2,'sha256':hashlib.sha256(b'ok').hexdigest()}
   with tarfile.open(archive,'w') as out:
    m=tarfile.TarInfo('a');m.size=2;m.mode=0o600;out.addfile(m,io.BytesIO(b'ok'))
    m=tarfile.TarInfo('b');m.type=tarfile.LNKTYPE;m.linkname='a';m.mode=0o600;out.addfile(m)
   intake=module('intake-cpu');intake.extract_tar(archive,root/'payload',{'a':row,'b':row});self.assertEqual((root/'payload/b').read_bytes(),b'ok')
   with self.assertRaises(AssertionError):intake.extract_tar(archive,root/'wrong',{'a':row,'b':dict(row,sha256='0'*64)})
 def test_supervisor_cancel_retires_exact_child_and_never_starts_second_case(self):
  # Execute real transformed supervisor with in-memory mocked process/kernel effects only.
  transform=module('freeze-cpu').supervisor_text
  text=transform((BASE/'upstream/cpu/campaign.py').read_text());ast.parse(text)
  self.assertIn("1500",(BASE/'upstream/cpu/case.mjs').read_text())
  self.assertIn("all(x<=10 for x in deltas.values())",text)
  with tempfile.TemporaryDirectory() as t:
   root=pathlib.Path(t);spec=root/'frozen.json';spec.write_text(json.dumps({'lane':'cpu','python':'fake-python','node':'fake-node','verifyScript':'fake-verify','output':str(root/'results'),'referenceBinary':'reference','referenceSha256':'x','systemPath':'/fake','cleanHome':str(root)}))
   child=types.SimpleNamespace(pid=2468,returncode=None);usage=types.SimpleNamespace(ru_utime=0,ru_stime=0);calls=0
   def wait4(pid,flags):
    nonlocal calls
    calls+=1
    if calls==1:signal.getsignal(signal.SIGTERM)(signal.SIGTERM,None);return 0,0,usage
    return pid,0,usage
   previous={n:signal.getsignal(n) for n in [signal.SIGTERM,signal.SIGINT]}
   try:
    with patch.object(sys,'argv',['campaign.py','--approved-campaign',str(spec)]),patch('subprocess.run') as verify,patch('subprocess.Popen',return_value=child) as spawn,patch('os.wait4',side_effect=wait4),patch('os.kill') as kill,patch('os.killpg') as killpg:
     with self.assertRaises(SystemExit):exec(compile(text,'campaign.py','exec'),{'__file__':str(root/'campaign.py'),'__name__':'__main__'})
     self.assertEqual(spawn.call_count,1);kill.assert_called_once_with(2468,15);killpg.assert_not_called();self.assertEqual(verify.call_count,1)
   finally:
    for n,handler in previous.items():signal.signal(n,handler)
   row=json.loads((root/'results/results.json').read_text())[0];self.assertTrue(row['timeout']);self.assertTrue(row['terminalKnown'])
 def test_wait4_node_requires_explicit_admitted_path(self):
  probe=module('test_wait4_aggregation')
  with patch('sys.stderr',io.StringIO()):
   for args in [[],['--node','node'],['--node','/missing/admitted/node']]:
    with self.assertRaises(SystemExit):probe.node_arguments(args)
  with tempfile.TemporaryDirectory() as t:
   node=pathlib.Path(t)/'node';node.write_bytes(b'fixture only; never executed')
   self.assertEqual(probe.node_arguments(['--node',str(node),'-v']),(str(node),['-v']))
  # Inspect actual freeze invocation, not a duplicate helper's proposed argv.
  tree=ast.parse((BASE/'freeze-cpu.py').read_text());calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='run']
  selected=[c.args[0] for c in calls if c.args and 'test_wait4_aggregation.py' in ast.unparse(c.args[0])]
  self.assertEqual(len(selected),1)
  command=selected[0];self.assertEqual(command.elts[-2].value,'--node')
  self.assertEqual(ast.unparse(command.elts[-1]),"paths['node']")
 def test_held_runner_rejects_before_transport(self):
  with tempfile.TemporaryDirectory() as t,patch('subprocess.run') as run:
   with self.assertRaisesRegex(AssertionError,'Held source'):module('runner').run(pathlib.Path(t)/'out')
   run.assert_not_called()
if __name__=='__main__':unittest.main()
