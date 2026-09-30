"""Actual installed Vitest/Vite loader regression; one trivial test, no product or tmux."""
import ast,json,os,pathlib,signal,subprocess,tempfile,unittest
HERE=pathlib.Path(__file__).resolve().parent

class NativeConfigLoader(unittest.TestCase):
 def test_external_symlinked_dependencies_leave_target_without_vite_temp(self):
  node=pathlib.Path(os.environ['TMUX_QUAL_NODE']);source=pathlib.Path(os.environ['TMUX_QUAL_SOURCE']).resolve(strict=True)
  self.assertTrue(node.is_absolute() and node.is_file())
  vitest=(source/'node_modules/vitest').resolve(strict=True)
  self.assertEqual(json.loads((vitest/'package.json').read_text())['version'],'4.1.6')
  vite=(vitest.parent/'vite').resolve(strict=True)
  self.assertEqual(json.loads((vite/'package.json').read_text())['version'],'8.2.2')
  # Inspect the actual workload argv, not a duplicated suggested command.
  tree=ast.parse((HERE/'run.py').read_text());commands=[n.value for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='command' for t in n.targets)]
  self.assertEqual(len(commands),1);items=commands[0].elts
  index=next(i for i,n in enumerate(items) if isinstance(n,ast.Constant) and n.value=='--configLoader')
  self.assertEqual(items[index+1].value,'native')
  with tempfile.TemporaryDirectory(prefix='tmi-native-config-') as temp:
   root=pathlib.Path(temp).resolve();external=root/'external';external.mkdir();target=root/'immutable-dependencies';target.mkdir()
   # Private dependency facade preserves the actual symlink topology without exposing shared deps to a regression write.
   (target/'vitest').symlink_to(vitest,target_is_directory=True)
   (external/'node_modules').symlink_to(target,target_is_directory=True)
   cache=external/'cache';cache.mkdir();home=root/'home';home.mkdir()
   test=external/'only.test.mjs';test.write_text("import {test,expect} from 'vitest'; test('pure loader fixture',()=>expect(2+2).toBe(4));\n")
   config=external/'vitest.config.mjs';config.write_text('export default '+json.dumps({'root':str(external),'cacheDir':str(cache),'test':{'environment':'node','maxWorkers':1,'pool':'threads','include':['only.test.mjs']}})+';\n')
   before={p.name:os.readlink(p) for p in target.iterdir()};report=external/'report.json'
   env={'HOME':str(home),'PATH':str(node.parent)+':/usr/bin:/bin:/usr/sbin:/sbin','LC_ALL':'en_US.UTF-8','TZ':'UTC'}
   child=subprocess.Popen([str(node),str(vitest/'vitest.mjs'),'run','--configLoader','native','--config',str(config),'--reporter=json','--outputFile',str(report)],cwd=external,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
   try:out,err=child.communicate(timeout=30)
   except subprocess.TimeoutExpired:
    os.killpg(child.pid,signal.SIGKILL);child.communicate(timeout=5);raise
   self.assertEqual(child.returncode,0,(out+err).decode(errors='replace'))
   result=json.loads(report.read_text());self.assertTrue(result['success']);self.assertEqual(result['numPassedTests'],1);self.assertEqual(result['numTotalTests'],1)
   self.assertFalse((target/'.vite-temp').exists(),'Config loader wrote through node_modules symlink')
   self.assertEqual({p.name:os.readlink(p) for p in target.iterdir()},before)
   self.assertEqual((external/'node_modules').resolve(),target)
   print(json.dumps({'vitest':'4.1.6','vite':'8.2.2','configLoader':'native','passedTests':1,'dependencyTargetUnchanged':True,'tmuxStarted':False}))
if __name__=='__main__':unittest.main()
