"""Draft Intel input preparation only; no performance campaign or instrumented native rebuild."""
import argparse, base64, hashlib, json, os, pathlib, platform, shutil, stat, struct
import tarfile, time, urllib.request, zipfile, sysconfig
from bounded import run_bounded
from package_payload import package_payload
from openssl_link import remedy_known_openssl
from brew_diagnostics import capture_logs, with_diagnostics
from brew_core import prepare_core
HERE = pathlib.Path(__file__).resolve().parent
PINS = json.loads((HERE / 'pins.json').read_text())

def digest(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for data in iter(lambda: f.read(1048576), b''): h.update(data)
    return h.hexdigest()

def contained(root, name):
    assert isinstance(name, str) and not pathlib.PurePosixPath(name).is_absolute()
    assert '..' not in pathlib.PurePosixPath(name).parts
    p = root / name
    assert p.resolve().is_relative_to(root.resolve())
    return p

def unpack_tar(archive, target, *, max_files=100000, max_bytes=1024**3):
    target.mkdir()
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        assert len(members) <= max_files and sum(m.size for m in members) <= max_bytes
        assert len({m.name for m in members}) == len(members)
        for m in members:
            p = contained(target, m.name)
            assert m.isdir() or m.isfile() or m.issym(), 'Special/hardlink archive entry'
            if m.issym():
                assert not pathlib.PurePosixPath(m.linkname).is_absolute()
                assert (p.parent / m.linkname).resolve().is_relative_to(target.resolve())
        # Links last, so no archive-created parent link can redirect a file write.
        for m in members:
            if m.issym(): continue
            p = contained(target, m.name)
            if m.isdir():
                p.mkdir(parents=True, exist_ok=True);p.chmod(m.mode & 0o777)
            else:
                p.parent.mkdir(parents=True, exist_ok=True)
                with p.open('xb') as f, tar.extractfile(m) as source: shutil.copyfileobj(source, f)
                p.chmod(m.mode & 0o777)
        for m in members:
            if m.issym():
                p = contained(target, m.name); p.parent.mkdir(parents=True, exist_ok=True)
                p.symlink_to(m.linkname)

def download(spec, target):
    started = time.monotonic(); total = 0
    with urllib.request.urlopen(spec['url'], timeout=30) as response, target.open('xb') as f:
        while True:
            assert time.monotonic() - started < 180, 'Download deadline'
            b = response.read(1048576)
            if not b: break
            total += len(b); assert total <= 256 * 1024**2, 'Download cap'
            f.write(b)
    if 'integrity' in spec:
        algorithm, expected = spec['integrity'].split('-', 1)
        assert algorithm == 'sha512'
        assert base64.b64encode(hashlib.sha512(target.read_bytes()).digest()).decode() == expected
    else: assert digest(target) == spec['digest']

def main():
    parser = argparse.ArgumentParser()
    for name in ('source', 'artifact', 'output'): parser.add_argument('--' + name, required=True)
    a = parser.parse_args(); source = pathlib.Path(a.source).resolve(); artifact = pathlib.Path(a.artifact).resolve()
    out = pathlib.Path(a.output).resolve(); out.mkdir(mode=0o700)
    os.umask(0o077)
    logs = out / 'logs'; logs.mkdir(); home = out / 'home'; home.mkdir()
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home), 'LC_ALL': 'C', 'TZ': 'UTC',
           'TMPDIR': str(out / 'tmp'), 'HOMEBREW_NO_AUTO_UPDATE': '1', 'HOMEBREW_NO_INSTALL_CLEANUP': '1',
           'HOMEBREW_CACHE': str(out / 'brew-cache'),
           'HOMEBREW_LOGS': str(out / 'tmp/homebrew-logs'), 'HOMEBREW_DISABLE_DEBREW': '1'}
    (out / 'tmp').mkdir(); stages = []; stage = 'host'; success = False; failure_stage = None
    def run(name, argv, cwd=None, timeout=60):
        nonlocal stage
        stage = name
        with (logs / (name + '.log')).open('xb') as f:
            r = run_bounded(argv, cwd=cwd, env=env, timeout=timeout, limit=8*1024**2, output=f)
        stages.append({'stage': name, 'code': r.returncode, 'truncated': r.truncated})
        (out / 'stages.json').write_text(json.dumps(stages, indent=2))
        assert r.returncode == 0 and not r.truncated, 'Input preparation stage failed/truncated'
        return (logs / (name + '.log')).read_text()
    try:
        assert platform.system() == 'Darwin' and platform.machine() == 'x86_64'
        assert run('source-head', ['git', 'rev-parse', 'HEAD'], source).strip() == PINS['sourceCommit']
        assert run('source-tree', ['git', 'rev-parse', 'HEAD^{tree}'], source).strip() == PINS['sourceTree']
        assert not run('source-clean', ['git', 'status', '--porcelain'], source).strip()
        host = {'platform': platform.platform(), 'loadBefore': os.getloadavg(), 'performanceQualified': False,
                'hostedRunner': True, 'exclusiveHostRequired': False, 'python': {'path': os.path.realpath(os.sys.executable), 'version': platform.python_version()},
                'runnerImage': {k: os.environ.get(k) for k in ('ImageOS','ImageVersion','RUNNER_ARCH','RUNNER_OS')}}
        for label, argv in [('sw-vers',['/usr/bin/sw_vers']),('uname',['/usr/bin/uname','-a']),
                            ('hardware',['/usr/sbin/sysctl','hw.model','hw.ncpu','hw.memsize','machdep.cpu.brand_string','kern.boottime']),
                            ('sdk',['/usr/bin/xcrun','--show-sdk-path']),('xcode',['/usr/bin/xcodebuild','-version']),
                            ('processes-before',['/bin/ps','-axo','pid=,ppid=,stat=,lstart=,command='])]:
            host[label] = run(label, argv)
        (out / 'host-before.json').write_text(json.dumps(host, indent=2))
        native = out / 'qualified-native'; native.mkdir()
        meta = json.loads((artifact / 'artifact.json').read_text()); wanted = PINS['nativeArtifact']
        assert meta['id'] == wanted['artifactId'] and meta['name'] == wanted['name'] and not meta['expired']
        assert meta['digest'] == 'sha256:' + wanted['digest']
        assert digest(artifact / 'qualified.zip') == wanted['digest']
        with zipfile.ZipFile(artifact / 'qualified.zip') as z:
            rows = z.infolist(); assert len(rows) <= 10000 and sum(x.file_size for x in rows) <= 1024**3
            assert len({x.filename for x in rows}) == len(rows)
            for row in rows:
                p = contained(native, row.filename)
                assert not stat.S_ISLNK(row.external_attr >> 16)
                if row.is_dir(): p.mkdir(parents=True, exist_ok=True)
                else:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    with p.open('xb') as f, z.open(row) as src: shutil.copyfileobj(src, f)
        manifest_path = native / 'bundle/manifest.json'
        assert digest(manifest_path) == wanted['manifestSha256']
        manifest = json.loads(manifest_path.read_text())
        assert manifest['platform'] == 'darwin' and manifest['arch'] == 'x64'
        assert json.loads((native / 'functional.json').read_text())['tests'] == 18
        cleanup = json.loads((native / 'cleanup.json').read_text()); assert cleanup['clean'] and cleanup['remaining'] == []
        assert (native / 'sanitizer-passed').is_file()
        for name, sha in manifest['files'].items():
            p = contained(native / 'bundle', name); assert digest(p) == sha
            if name == 'tmux' or name.startswith('lib/'):
                assert struct.unpack('<II', p.read_bytes()[:8]) == (0xfeedfacf,0x01000007)
                p.chmod(0o755) # Actions archives lose executable modes; bytes remain exact.
        tools = out / 'tools'; tools.mkdir(); downloads = out / 'downloads'; downloads.mkdir(); bins = out / 'bin'; bins.mkdir()
        executables = {}
        for name, spec in PINS['downloads'].items():
            archive = downloads / (name + '.tgz'); download(spec, archive)
            directory = tools / name; unpack_tar(archive, directory)
            executables[name] = directory / spec['root'] / spec['executable']
        for name in ('node','bun'): (bins/name).symlink_to(executables[name])
        env['PATH'] = str(bins) + ':' + env['PATH']
        node = str(executables['node']); bun = str(executables['bun']); pnpm = [node,str(executables['pnpm'])]
        for name, argv in [('node',[node]),('bun',[bun]),('pnpm',pnpm)]:
            assert run(name+'-version',argv+['--version']).strip() == PINS['downloads'][name]['version']
        assert json.loads(run('node-platform',[node,'-p','JSON.stringify([process.platform,process.arch])'])) == ['darwin','x64']
        # This is dependency preparation, not runtime or a performance measurement.
        run('brew-before',['brew','info','--json=v2','automake','autoconf','pkgconf','libevent','ncurses','utf8proc'])
        stage='openssl-link-admission'
        remedy_known_openssl(run,lambda name,value:(out/name).write_text(json.dumps(value,indent=2)),os.environ)
        stage='core-tap-admission'
        try:
            prepare_core(run,lambda receipt:(out/'core-tap.json').write_text(json.dumps(receipt,indent=2)),env,os.environ,PINS['homebrewCore'])
        except BaseException:
            stage='core-tap-admission'
            raise
        with_diagnostics(
            lambda:run('brew-build-inputs',['brew','install','--verbose','--debug','--build-from-source','automake','autoconf','pkgconf','libevent','ncurses','utf8proc'],timeout=1800),
            lambda:capture_logs(out/'tmp/homebrew-logs',logs/'homebrew'),
            lambda status:(logs/'homebrew-capture.json').write_text(json.dumps(status,indent=2)))
        run('brew-after',['brew','info','--json=v2','automake','autoconf','pkgconf','libevent','ncurses','utf8proc'])
        for name in ('libevent','ncurses','utf8proc'):
            prefix=run('prefix-'+name,['brew','--prefix',name]).strip()
            env['PKG_CONFIG_PATH'] = env.get('PKG_CONFIG_PATH','') + (':' if env.get('PKG_CONFIG_PATH') else '') + prefix + '/lib/pkgconfig'
        frozen_source = out/'source'; frozen_source.mkdir()
        files = run('tracked-source',['git','ls-files','-z'],source).split('\0')
        for name in filter(None,files):
            src = contained(source,name); dest = contained(frozen_source,name); dest.parent.mkdir(parents=True,exist_ok=True)
            assert src.is_file() and not src.is_symlink(); shutil.copy2(src,dest)
        run('fetch-offline-store',pnpm+['fetch','--frozen-lockfile','--store-dir',str(out/'pnpm-store')],frozen_source,timeout=600)
        assert digest(frozen_source/'pnpm-lock.yaml') == digest(source/'pnpm-lock.yaml')
        upstream=out/'upstream'
        run('upstream-init',['git','init',str(upstream)])
        run('upstream-fetch',['git','-C',str(upstream),'fetch','--depth=1','https://github.com/tmux/tmux.git',PINS['upstream']],timeout=120)
        run('upstream-checkout',['git','-C',str(upstream),'checkout','--detach','FETCH_HEAD'])
        assert run('upstream-head',['git','-C',str(upstream),'rev-parse','HEAD']).strip() == PINS['upstream']
        ref_recipe=out/'reference-recipe'; shutil.copytree(frozen_source,ref_recipe,symlinks=True)
        run('reference-offline-dependencies',pnpm+['install','--offline','--frozen-lockfile','--ignore-scripts','--side-effects-cache=false','--store-dir',str(out/'pnpm-store')],ref_recipe,timeout=600)
        assert digest(ref_recipe/'native/tmux/COPYING') == digest(source/'native/tmux/COPYING')
        assert digest(ref_recipe/'packages/daemon/src/terminal/mirror/native-grid-capture.ts') == digest(source/'packages/daemon/src/terminal/mirror/native-grid-capture.ts')
        provenance=ref_recipe/'native/tmux/provenance.json'; before=provenance.read_bytes(); data=json.loads(before)
        assert digest(ref_recipe/'native/tmux/native-grid.patch') == PINS['gridPatch']
        data['patches']=[p for p in data['patches'] if p['patch']=='native-grid.patch']; assert len(data['patches'])==1
        assert data['patches'][0]['patchSha256'] == PINS['gridPatch']
        data['experimentalExtensions']=[]; provenance.write_text(json.dumps(data,indent=2))
        (out/'reference-provenance-before.json').write_bytes(before)
        run('build-grid-only-reference',[node,str(ref_recipe/'scripts/build-bundled-tmux.mjs'),'--source',str(upstream),'--output',str(out/'grid-reference'),'--jobs','2'],timeout=600)
        reference=json.loads((out/'grid-reference/manifest.json').read_text())
        assert reference['arch']=='x64' and reference['patches']==data['patches'] and not reference.get('experimentalExtensions',[])
        roots=[node,bun,str(native/'bundle/tmux'),str(out/'grid-reference/tmux')]
        (out/'mach-roots.json').write_text(json.dumps(roots))
        run('mach-closure',[node,str(HERE/'mach-inputs.mjs'),str(out/'mach-roots.json'),str(out/'mach-closure.json')])
        tool_receipt={}
        for name,argv in [('node',[node]),('bun',[bun]),('pnpm',[str(executables['pnpm'])]),
                          ('python',[os.path.realpath(os.sys.executable)]),('otool',['/usr/bin/otool']),
                          ('ps',['/bin/ps']),('pgrep',['/usr/bin/pgrep']),('xcrun',['/usr/bin/xcrun'])]:
            path=pathlib.Path(argv[0]);tool_receipt[name]={'path':str(path),'resolved':str(path.resolve()),'sha256':digest(path)}
        tool_receipt['compiler']={'path':run('compiler-path',['/usr/bin/xcrun','--find','clang']).strip()}
        tool_receipt['compiler']['sha256']=digest(tool_receipt['compiler']['path'])
        for name in ('git','bash','sh','make','autoconf','automake','aclocal','pkg-config','install_name_tool','codesign','lipo'):
            path=shutil.which(name,path=env['PATH']); assert path, 'Missing build tool'
            tool_receipt[name]={'path':path,'resolved':os.path.realpath(path),'sha256':digest(path)}
        tool_receipt['python']['stdlib']=sysconfig.get_path('stdlib')
        (out/'tool-receipt.json').write_text(json.dumps(tool_receipt,indent=2))
        # Save source/recipe bytes. The later CLI preparation may apply only the separately reviewed32 overlay.
        shutil.copytree(HERE,out/'recipe',ignore=shutil.ignore_patterns('__pycache__'))
        for name, sha in manifest['files'].items(): assert digest(native/'bundle'/name) == sha
        success=True
    except BaseException:
        failure_stage = stage
        raise
    finally:
        try:
            run('processes-after',['/bin/ps','-axo','pid=,ppid=,stat=,lstart=,command='])
        finally:
            (out/'preparation-status.json').write_text(json.dumps({'ok':success,'stage':stage,'failureStage':failure_stage,'loadAfter':os.getloadavg(),'performanceQualified':False,'cliBuilt':False,'instrumentedNativeRebuilt':False},indent=2))
    if success:
        hashes={};links={}
        for parent,dirs,files in os.walk(out,followlinks=False):
            dirs[:]=[d for d in dirs if d not in ('.git','home','tmp','brew-cache')]
            for name in dirs+files:
                p=pathlib.Path(parent)/name
                if p.is_symlink(): links[str(p.relative_to(out))]={'target':os.readlink(p),'resolved':str(p.resolve())}
                elif p.is_file(): hashes[str(p.relative_to(out))]=digest(p)
        external={}
        for path in pathlib.Path(sysconfig.get_path('stdlib')).rglob('*'):
            if path.is_file(): external[str(path.resolve())]=digest(path)
        for entry in json.loads((out/'tool-receipt.json').read_text()).values(): external[entry['resolved'] if 'resolved' in entry else entry['path']]=entry['sha256']
        (out/'input-closure.json').write_text(json.dumps({'source':PINS['sourceCommit'],'tree':PINS['sourceTree'],'hashes':hashes,'symlinks':links,'externalToolPythonFiles':external,'hostMachClosureComplete':True,'performanceQualified':False},indent=2))
        paths={'originalPreparationRoot':str(out),'rebindRequired':True,'source':'source','offlineStore':'pnpm-store','native':'qualified-native/bundle/tmux','reference':'grid-reference/tmux','tools':{name:str(path.relative_to(out)) for name,path in executables.items()},'hostBuildToolsAreReceiptsOnly':True,'nextHostMustRevalidateMachAndToolClosure':True,'private32OverlayApplied':False}
        (out/'payload-path-map.json').write_text(json.dumps(paths,indent=2))
        packaged=False
        try:
            package_payload(out,unpack_tar);packaged=True
        finally:
            (out/'payload-status.json').write_text(json.dumps({'ok':packaged,'performanceQualified':False,'roundtripRequired':True},indent=2))

if __name__ == '__main__': main()
