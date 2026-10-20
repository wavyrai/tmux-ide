import subprocess, pathlib, sys
root=pathlib.Path.cwd()
base=root/'.tasks/native-reliability-mission/nr09-bridge-baseline'
node=root/'.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node'
for pair in range(1,6):
    order=['quiet','busy'] if pair%2 else ['busy','quiet']
    for scenario in order:
        name=f'pair-{pair}-{scenario}'
        with (base/(name+'.log')).open('x') as log:
            result=subprocess.run([str(node),'--import','tsx',str(base/'run.mjs'),scenario,str(base/(name+'.json'))],stdout=log,stderr=subprocess.STDOUT,cwd=root)
        print(name, result.returncode, flush=True)
        if result.returncode:sys.exit(result.returncode)
