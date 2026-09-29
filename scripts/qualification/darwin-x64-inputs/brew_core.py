"""Official tap checkout for the API revision already observed on hosted Intel."""
import hashlib, os, pathlib
CORE=pathlib.Path('/usr/local/Homebrew/Library/Taps/homebrew/homebrew-core')
REPOSITORY='https://github.com/Homebrew/homebrew-core'

def validate_checkout(run, pins, directory=CORE):
    assert run('core-origin',['git','-C',str(directory),'remote','get-url','origin']).strip() in (REPOSITORY,REPOSITORY+'.git')
    head=run('core-head',['git','-C',str(directory),'rev-parse','HEAD']).strip()
    tree=run('core-tree',['git','-C',str(directory),'rev-parse','HEAD^{tree}']).strip()
    assert head==pins['revision'] and tree==pins['tree'],'Core identity mismatch'
    assert not run('core-clean',['git','-C',str(directory),'status','--porcelain']).strip(),'Dirty core checkout'
    formulas={}
    for name,pin in pins['formulas'].items():
        path=directory/pin['path']
        assert path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(directory.resolve())
        actual=hashlib.sha256(path.read_bytes()).hexdigest()
        assert actual==pin['sha256'],'Formula differs from pinned API inputs'
        formulas[name]={'path':pin['path'],'sha256':actual}
    return {'origin':REPOSITORY,'head':head,'tree':tree,'formulas':formulas,'installFromApi':False}

def prepare_core(run, save, env, hosted, pins):
    assert hosted.get('GITHUB_ACTIONS')=='true' and hosted.get('RUNNER_ENVIRONMENT')=='github-hosted'
    assert hosted.get('RUNNER_OS')=='macOS' and hosted.get('RUNNER_ARCH')=='X64'
    assert pins['repository']==REPOSITORY
    assert not os.path.lexists(CORE),'Existing core tap is not owned by this preparation'
    assert run('brew-repository',['brew','--repository']).strip()=='/usr/local/Homebrew'
    # Set before tap: API mode otherwise treats the core checkout as unnecessary.
    env['HOMEBREW_NO_INSTALL_FROM_API']='1'
    run('core-tap',['brew','tap','homebrew/core'],timeout=600)
    assert CORE.is_dir() and not CORE.is_symlink()
    assert run('core-tap-origin',['git','-C',str(CORE),'remote','get-url','origin']).strip() in (REPOSITORY,REPOSITORY+'.git')
    assert not run('core-tap-clean',['git','-C',str(CORE),'status','--porcelain']).strip()
    run('core-fetch',['git','-C',str(CORE),'fetch','--depth=1','origin',pins['revision']],timeout=120)
    run('core-checkout',['git','-C',str(CORE),'checkout','--detach',pins['revision']])
    save(validate_checkout(run,pins))
