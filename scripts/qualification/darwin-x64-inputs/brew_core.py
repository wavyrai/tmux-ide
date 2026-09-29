"""Official tap checkout for the API revision already observed on hosted Intel."""
import hashlib, os, pathlib, re, stat
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
    receipt={'path':str(CORE),'existed':os.path.lexists(CORE),'before':None,'after':None}
    save(receipt)
    assert run('brew-repository',['brew','--repository']).strip()=='/usr/local/Homebrew'
    # Set before tap: API mode otherwise treats the core checkout as unnecessary.
    env['HOMEBREW_NO_INSTALL_FROM_API']='1'
    if not receipt['existed']:
        run('core-tap',['brew','tap','homebrew/core'],timeout=600)
    st=CORE.lstat()
    receipt['before']={'device':st.st_dev,'inode':st.st_ino,'mode':st.st_mode}
    save(receipt)
    assert stat.S_ISDIR(st.st_mode) and not CORE.is_symlink(),'Core is not a real directory'
    assert (CORE/'.git').is_dir() and not (CORE/'.git').is_symlink(),'Core is not a standalone git checkout'
    before=receipt['before']
    for key,args in [('root',['rev-parse','--show-toplevel']),('origin',['remote','get-url','origin']),
                     ('head',['rev-parse','HEAD']),('tree',['rev-parse','HEAD^{tree}']),
                     ('dirty',['status','--porcelain'])]:
        before[key]=run('core-before-'+key,['git','-C',str(CORE),*args]).strip()
        save(receipt)
    assert pathlib.Path(before['root']).resolve()==CORE.resolve(),'Unexpected git root'
    assert before['origin'] in (REPOSITORY,REPOSITORY+'.git'),'Nonofficial core origin'
    assert not before['dirty'],'Dirty core checkout'
    assert re.fullmatch('[0-9a-f]{40}',before['head']) and re.fullmatch('[0-9a-f]{40}',before['tree'])
    current=CORE.lstat()
    assert (current.st_dev,current.st_ino,current.st_mode)==(st.st_dev,st.st_ino,st.st_mode),'Core directory changed'
    run('core-fetch',['git','-C',str(CORE),'fetch','--depth=1','origin',pins['revision']],timeout=120)
    run('core-checkout',['git','-C',str(CORE),'checkout','--detach',pins['revision']])
    receipt['after']=validate_checkout(run,pins)
    save(receipt)
