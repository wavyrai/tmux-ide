"""Pure helper/pipe/socket fixtures only; never starts tmux or the live reader."""
import pathlib,subprocess,json
R=pathlib.Path('/work/source/.tasks/components-linux');env={'HOME':'/work/home','PATH':'/opt/node26/bin:/pinned:/usr/bin:/bin','PYTHONPATH':str(R/'common'),'LC_ALL':'C','TZ':'UTC'}
commands=[['/opt/node26/bin/node','--test',str(R/'owned-process.test.mjs'),str(R/'parser/cleanup-witnesses.test.mjs')]]
commands += [['/usr/bin/python3',str(p)] for lane in ['metadata','tail'] for p in sorted((R/lane).glob('test_*.py'))]
results=[]
for command in commands:
 r=subprocess.run(command,env=env,timeout=30);results.append({'command':command,'exit':r.returncode});assert r.returncode==0
pathlib.Path('/evidence/component-tests.json').write_text(json.dumps({'passed':True,'commands':results}))
