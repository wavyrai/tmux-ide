import os,pathlib,tempfile,subprocess,json,hashlib
repo=pathlib.Path.cwd();base=repo/'.tasks/native-reliability-mission/installer-lifecycle';root=pathlib.Path(tempfile.mkdtemp(prefix='private-',dir=base));home=root/'home';home.mkdir();prefix=root/'installed';tools=root/'tools';tools.mkdir();node=repo/'.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node';npm='/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js';(tools/'node').symlink_to(node)
tar=repo/'.tasks/native-reliability-mission/packaged-paste/package-297-8yx0htjo/artifacts/tmux-ide-2.9.7.tgz';sha=lambda x:hashlib.sha256(x.read_bytes()).hexdigest();before=sha(repo/'bin/cli.js');env={k:v for k,v in os.environ.items() if not(k.startswith('TMUX') or k.startswith('npm_') or k in ['NODE_OPTIONS','NODE_PATH'])};env.update(HOME=str(home),PATH=str(tools)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',XDG_CONFIG_HOME=str(home/'.config'),XDG_STATE_HOME=str(home/'.state'),XDG_CACHE_HOME=str(home/'.cache'),npm_config_cache=str(root/'cache'),npm_config_userconfig=str(root/'empty-npmrc'),TMUX_IDE_HOME=str(root/'state'),TMUX_IDE_SETTINGS_DIR=str(root/'settings'),TMUX_IDE_CONFIG=str(root/'config.json'),TMUX_IDE_DAEMON_INFO_DIR=str(root/'canonical'),TMUX_IDE_REGISTRY_DIR=str(root/'canonical'))
receipt={'scope':'installer lifecycle policy only; not full installer/network journey','root':str(root),'tarballSha256':sha(tar),'commands':[]};(base/'current-root.txt').write_text(str(root))
def run(name,args,cwd,extra=None):
 with (root/(name+'.log')).open('wb') as f:r=subprocess.run(args,cwd=cwd,env={**env,**(extra or {})},stdout=f,stderr=subprocess.STDOUT,timeout=180)
 receipt['commands'].append({'name':name,'argv':args,'exitCode':r.returncode,'extraEnvironment':extra or {}});return r.returncode
try:
 assert run('install',[str(node),npm,'install','--global','--prefix',str(prefix),'--ignore-scripts',str(tar)],home)==0
 pkg=prefix/'lib/node_modules/tmux-ide';receipt['installedPackage']=str(pkg);receipt['cliSha256']=sha(pkg/'bin/cli.js');receipt['manifestSha256']=sha(pkg/'package.json');receipt['postinstallSha256']=sha(pkg/'scripts/postinstall.js')
 assert run('own-postinstall',[str(node),str(pkg/'scripts/postinstall.js')],pkg,{'npm_config_global':'false'})==0
 assert run('dependency-load',[str(node),'-e',"require('node-pty'); require('@parcel/watcher'); console.log('native dependencies load')"],pkg)==0
 assert run('version',[str(node),str(pkg/'bin/cli.js'),'--version'],home)==0
 assert (root/'version.log').read_text().strip()=='tmux-ide v2.9.7';receipt['pass']=True
except Exception as e:receipt['pass']=False;receipt['failure']=str(e)
finally:
 receipt['canonicalRecordAbsent']=not(root/'canonical/daemon.json').exists();receipt['stateRecordAbsent']=not(root/'state/daemon.json').exists();receipt['defaultHomeRecordAbsent']=not(home/'.tmux-ide/daemon.json').exists();receipt['protectedCliUnchanged']=before==sha(repo/'bin/cli.js');receipt['pass']=receipt['pass'] and receipt['canonicalRecordAbsent'] and receipt['stateRecordAbsent'] and receipt['defaultHomeRecordAbsent'] and receipt['protectedCliUnchanged'];(root/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
