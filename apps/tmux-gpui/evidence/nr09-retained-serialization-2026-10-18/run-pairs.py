import pathlib,subprocess,json,hashlib
root=pathlib.Path.cwd();base=root/'.tasks/native-reliability-mission/nr09-retained-serialization';node=root/'.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node';harness=base/'run.mjs';sha=lambda:hashlib.sha256(harness.read_bytes()).hexdigest();expected=sha();runs=[]
for pair in range(1,6):
 for variant in (['baseline','candidate'] if pair%2 else ['candidate','baseline']):
  assert sha()==expected
  output=base/f'pair-{pair}-{variant}.json';assert not output.exists()
  with (base/f'pair-{pair}-{variant}.log').open('x') as log:
   result=subprocess.run([str(node),'--import','tsx',str(harness),'quiet',str(output),variant],stdout=log,stderr=subprocess.STDOUT,cwd=root,timeout=120)
  assert result.returncode==0,(pair,variant,result.returncode)
  receipt=json.loads(output.read_text());assert receipt['passed'] and sha()==expected
  runs.append({'pair':pair,'variant':variant,'output':str(output),'passed':True})
  (base/'runset.json').write_text(json.dumps({'harnessSha256':expected,'runs':runs},indent=2)+'\n')
  print(pair,variant,'passed',flush=True)
