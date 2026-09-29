"""Narrow remedy for the exact legacy OpenSSL link observed on hosted Intel CI."""
import hashlib, os, pathlib, stat
LINK = '/usr/local/bin/openssl'
TARGET = '/usr/local/opt/openssl@1.1/bin/openssl'
CELLAR = '/usr/local/Cellar/openssl@1.1'

def inspect_link():
    p=pathlib.Path(LINK)
    try: st=p.lstat()
    except FileNotFoundError: return {'path':LINK,'state':'absent'}
    result={'path':LINK,'state':'symlink' if stat.S_ISLNK(st.st_mode) else 'other',
            'device':st.st_dev,'inode':st.st_ino,'uid':st.st_uid,'mode':st.st_mode,'mtimeNs':st.st_mtime_ns}
    if result['state']=='symlink':
        result['target']=os.readlink(p)
        try: result['resolved']=str(p.resolve(strict=True))
        except FileNotFoundError:
            result['resolved']=None;return result
        if result['target']==TARGET and result['resolved'].startswith(CELLAR+'/'):
            real=pathlib.Path(result['resolved']);target=real.stat()
            assert stat.S_ISREG(target.st_mode)
            result['file']={'device':target.st_dev,'inode':target.st_ino,'size':target.st_size,
                            'sha256':hashlib.sha256(real.read_bytes()).hexdigest()}
    return result

def remedy_known_openssl(run, save, environment, observe=inspect_link, unlink=os.unlink):
    assert environment.get('GITHUB_ACTIONS')=='true'
    assert environment.get('RUNNER_ENVIRONMENT')=='github-hosted'
    assert environment.get('RUNNER_OS')=='macOS' and environment.get('RUNNER_ARCH')=='X64'
    before=observe();save('openssl-link-before.json',before)
    assert before['path']==LINK,'Unknown OpenSSL path'
    if before['state']=='absent':
        save('openssl-link-after.json',{'action':'not-needed','observation':before});return
    assert before['path']==LINK and before['state']=='symlink' and before.get('target')==TARGET,'Unknown OpenSSL conflict'
    assert isinstance(before.get('resolved'),str),'Broken OpenSSL formula link'
    resolved=pathlib.PurePosixPath(before['resolved']);base=pathlib.PurePosixPath(CELLAR)
    assert resolved.is_relative_to(base) and len(resolved.relative_to(base).parts)==3
    version,bindir,executable=resolved.relative_to(base).parts
    assert bindir=='bin' and executable=='openssl' and before.get('file'),'Unknown OpenSSL formula file'
    prefix=run('openssl1-prefix',['brew','--prefix','--installed','openssl@1.1']).strip()
    cellar=run('openssl1-cellar',['brew','--cellar','openssl@1.1']).strip()
    versions=run('openssl1-versions',['brew','list','--versions','openssl@1.1']).split()
    files=run('openssl1-files',['brew','list','--verbose','openssl@1.1']).splitlines()
    formula={'prefix':prefix,'cellar':cellar,'versions':versions,'resolvedFile':str(resolved),'fileListed':str(resolved) in files}
    save('openssl-formula-before.json',formula)
    assert prefix=='/usr/local/opt/openssl@1.1' and cellar==CELLAR
    assert versions and versions[0]=='openssl@1.1' and version in versions[1:] and formula['fileListed'],'OpenSSL formula identity mismatch'
    current=observe();save('openssl-link-revalidated.json',current)
    assert current==before,'OpenSSL link changed before unlink'
    try:
        run('openssl1-unlink',['brew','unlink','openssl@1.1'])
    finally:
        after=observe();save('openssl-link-after.json',{'action':'supported-unlink','observation':after})
    if after['state']!='absent':
        save('openssl-link-supported-unlink-leftover.json',after)
        assert after==before,'OpenSSL link changed after supported unlink'
        current=observe();save('openssl-link-fallback-revalidated.json',current)
        assert current==before,'OpenSSL link changed before exact symlink removal'
        # unlink removes the directory entry, never follows the symlink target.
        try:
            unlink(LINK)
        finally:
            after=observe()
            save('openssl-link-after.json',{'action':'verified-leftover-symlink-unlink','observation':after})
    assert after['state']=='absent','OpenSSL link not absent after retirement'
