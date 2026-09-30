"""Actual staged import graph only, with child-process/listener guards; no tmux or daemon."""
import pathlib,os,json,tempfile,subprocess,unittest,importlib.util,sys
from stage import stage_sources
BASE=pathlib.Path(__file__).resolve().parent
class LauncherImports(unittest.TestCase):
 def test_tsx_loads_actual_case_import_graph_with_no_fixture_launch(self):
  source=pathlib.Path(os.environ['TMUX_QUAL_SOURCE']).resolve();node=pathlib.Path(os.environ['TMUX_QUAL_NODE']);self.assertTrue(node.is_absolute())
  tsx=source/'node_modules/tsx/dist/loader.mjs';self.assertEqual(json.loads((source/'node_modules/tsx/package.json').read_text())['version'],'4.21.0')
  with tempfile.TemporaryDirectory(prefix='tmi-import-only-') as t:
   root=pathlib.Path(t);overlay=root/'overlay';stage_sources({'executionAuthorized':False,'runtimePatch':None,'paths':{'source':str(source),'node':str(root/'admitted-node-placeholder'),'cli':str(root/'never-executed-cli'),'native':str(root/'never-executed-tmux')}},overlay)
   # Parse and retain EVERY actual static import declaration, omit all workload statements.
   extractor=root/'imports.mjs';extractor.write_text("import {createRequire} from 'node:module';import{readFileSync,writeFileSync}from'node:fs';const ts=createRequire(process.argv[2]+'/package.json')('typescript');for(const lane of ['cpu','idle']){const p=process.argv[3]+'/'+lane+'/case.mjs',s=readFileSync(p,'utf8'),a=ts.createSourceFile(p,s,ts.ScriptTarget.Latest,true);const imports=a.statements.filter(ts.isImportDeclaration);if(imports.length<10)throw Error('missing case imports');writeFileSync(process.argv[3]+'/'+lane+'/import-only.mjs',imports.map(x=>x.getText(a)).join('\\n')+'\\nconsole.log(\"IMPORTS_OK\");\\n');}")
   subprocess.run([str(node),str(extractor),str(source),str(overlay)],check=True,timeout=10)
   guard=root/'guard.mjs';guard.write_text("import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';import net from'node:net';for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){const original=cp[name];cp[name]=function(exe,args,...rest){if(name==='spawn'&&typeof exe==='string'&&/(?:^|\\/)esbuild$/.test(exe)&&Array.isArray(args)&&args.some(x=>x.startsWith('--service=')))return original.call(this,exe,args,...rest);throw Error('FORBIDDEN_CHILD '+name+' '+exe);};}net.Server.prototype.listen=function(){throw Error('FORBIDDEN_LISTENER');};syncBuiltinESMExports();")
   env=dict(os.environ,TSX_DISABLE_CACHE='1',TMPDIR=str(root),HOME=str(root),TMUX='')
   plain=subprocess.run([str(node),'--import',str(guard),str(overlay/'cpu/import-only.mjs')],env=env,capture_output=True,text=True,timeout=30)
   self.assertNotEqual(plain.returncode,0);self.assertIn('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',plain.stderr)
   for lane in ['cpu','idle']:
    result=subprocess.run([str(node),'--import',str(guard),'--import',str(tsx),str(overlay/lane/'import-only.mjs')],env=env,capture_output=True,text=True,timeout=30)
    self.assertEqual(result.returncode,0,result.stdout+result.stderr);self.assertIn('IMPORTS_OK',result.stdout)
   print(json.dumps({'actualStagedImportGraphs':['cpu','idle'],'tsx':'4.21.0','cacheDisabled':True,'nonEsbuildChildrenForbidden':True,'listenersForbidden':True,'workloadBodyEvaluated':False}))
if __name__=='__main__':unittest.main()
