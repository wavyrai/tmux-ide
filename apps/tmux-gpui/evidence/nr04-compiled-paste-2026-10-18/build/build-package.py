import os, pathlib, tempfile, subprocess, json, hashlib, shutil
repo=pathlib.Path.cwd(); root=pathlib.Path(tempfile.mkdtemp(prefix='package-297-',dir=repo/'.tasks/native-reliability-mission/packaged-paste')); source=root/'source';source.mkdir();artifacts=root/'artifacts';artifacts.mkdir(); home=root/'home';home.mkdir();tools=root/'tools';tools.mkdir(); prefix=root/'installed'
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
commit=subprocess.check_output(['git','rev-parse','e0f813bd'],text=True).strip(); before=sha(repo/'bin/cli.js');receipt={'sourceCommit':commit,'protectedCliBefore':before,'root':str(root),'phases':[]};(repo/'.tasks/native-reliability-mission/packaged-paste/current-package-root.txt').write_text(str(root))
node=repo/'.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node'; npm=pathlib.Path('/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js');(tools/'node').symlink_to(node);(tools/'npm').symlink_to(npm);(tools/'pnpm').symlink_to('/opt/homebrew/bin/pnpm')
env={k:v for k,v in os.environ.items() if not(k.startswith('TMUX_IDE_') or k.startswith('npm_') or k in ['TMUX','TMUX_PANE','TMUX_TMPDIR','NODE_OPTIONS','NODE_PATH'])};env.update(HOME=str(home),PATH=str(tools)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',XDG_CONFIG_HOME=str(home/'.config'),XDG_STATE_HOME=str(home/'.state'),XDG_CACHE_HOME=str(home/'.cache'),npm_config_cache=str(root/'npm-cache'),npm_config_userconfig=str(root/'empty-npmrc'),TMUX_IDE_HOME=str(root/'state'),TMUX_IDE_SETTINGS_DIR=str(root/'settings'),TMUX_IDE_CONFIG=str(root/'config.json'),TMUX_IDE_DAEMON_INFO_DIR=str(root/'canonical'),TMUX_IDE_REGISTRY_DIR=str(root/'canonical'))
(tools/'bun').symlink_to('/private/tmp/tmux-ide-295-release-nkydyctm/tools/bun')
env['TMUX_IDE_RELEASE_COMMIT']=commit
def run(args,cwd,name,timeout=180):
 with open(root/(name+'.log'),'wb') as log:r=subprocess.run(args,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=timeout)
 receipt['phases'].append({'name':name,'exitCode':r.returncode});assert r.returncode==0,name
try:
 with open(root/'source.tar','wb') as f:subprocess.run(['git','archive',commit],stdout=f,check=True)
 subprocess.run(['tar','-xf',str(root/'source.tar'),'-C',str(source)],check=True)
 objects=subprocess.check_output(['git','rev-parse','--git-path','objects'],text=True).strip()
 env['GIT_ALTERNATE_OBJECT_DIRECTORIES']=str(pathlib.Path(objects).resolve())
 subprocess.run(['git','init','-q',str(source)],check=True)
 subprocess.run(['git','read-tree',commit],cwd=source,env=env,check=True)
 subprocess.run(['git','update-ref','HEAD',commit],cwd=source,env=env,check=True)
 (source/'node_modules').mkdir()
 for dep in (repo/'node_modules').iterdir():
  if dep.name!='@tmux-ide':(source/'node_modules'/dep.name).symlink_to(dep,target_is_directory=dep.is_dir())
 (source/'node_modules/@tmux-ide').mkdir()
 for pkg in (source/'packages').iterdir():
  if (pkg/'package.json').exists():
   name=json.loads((pkg/'package.json').read_text()).get('name','')
   if name.startswith('@tmux-ide/'):(source/'node_modules'/name).symlink_to(pkg,target_is_directory=True)
 for dep in (repo/'packages/daemon/node_modules').iterdir():
  if dep.name.startswith('@'):
   scope=source/'node_modules'/dep.name
   if not scope.exists():scope.mkdir()
   if not scope.is_symlink():
    for child in dep.iterdir():
     dest=scope/child.name
     if not dest.exists():dest.symlink_to(child.resolve(),target_is_directory=child.is_dir())
  else:
   dest=source/'node_modules'/dep.name
   if not dest.exists():dest.symlink_to(dep.resolve(),target_is_directory=dep.is_dir())
 assert json.loads((source/'package.json').read_text())['version']=='2.9.7'
 native=repo/'packages/daemon/dist/native/tmux/darwin-arm64';manifest=json.loads((native/'manifest.json').read_text())
 for p,h in manifest['files'].items():assert sha(native/p)==h,p
 receipt['native']={'version':manifest['version'],'commit':manifest['commit'],'manifestSha256':sha(native/'manifest.json'),'tmuxSha256':sha(native/'tmux'),'verifiedFiles':len(manifest['files'])}
 shutil.copytree(repo/'packages/daemon/dist/native',source/'packages/daemon/dist/native',symlinks=True)
 receipt['tools']={k:subprocess.check_output(v,env=env,text=True).strip() for k,v in {'node':[str(node),'-v'],'npm':[str(node),str(npm),'--version'],'pnpm':[str(tools/'pnpm'),'--version']}.items()}
 run([str(tools/'bun'),'scripts/build-tui.mjs'],source,'build-tui',180)
 receipt['tuiSha256']=sha(source/'packages/daemon/dist/tui/tmux-ide-tui')
 run([str(node),str(npm),'pack','--pack-destination',str(artifacts)],source,'pack')
 tarball=artifacts/'tmux-ide-2.9.7.tgz';receipt['tarballSha256']=sha(tarball)
 run([str(node),str(npm),'install','--global','--prefix',str(prefix),'--foreground-scripts',str(tarball)],home,'install',300)
 pkg=prefix/'lib/node_modules/tmux-ide'; receipt['installedPackage']=str(pkg);receipt['packageJsonSha256']=sha(pkg/'package.json');receipt['cliSha256']=sha(pkg/'bin/cli.js');receipt['installedTuiSha256']=sha(pkg/'packages/daemon/dist/tui/tmux-ide-tui');assert receipt['installedTuiSha256']==receipt['tuiSha256']
 assert receipt['cliSha256']==sha(source/'bin/cli.js');assert (pkg/'package.json').read_bytes()==(source/'package.json').read_bytes()
 assert not (root/'canonical/daemon.json').exists()
 run([str(node),str(pkg/'bin/cli.js'),'--version'],home,'version')
 assert (root/'version.log').read_text().strip()=='tmux-ide v2.9.7'
 receipt['passed']=True
except Exception as e:receipt['passed']=False;receipt['failure']=str(e)
finally:
 receipt['protectedCliAfter']=sha(repo/'bin/cli.js');receipt['protectedCliUnchanged']=receipt['protectedCliBefore']==receipt['protectedCliAfter'];(root/'receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt));
