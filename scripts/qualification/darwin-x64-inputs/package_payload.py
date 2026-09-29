"""Private reusable archive; preserves file modes and internal links, verifies extraction."""
import hashlib,json,os,pathlib,shutil,stat,tarfile,tempfile

def sha(path):
    h=hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return h.hexdigest()

def package_payload(root, unpack):
    root=pathlib.Path(root).resolve(); members=[]
    include_dirs={'source','tools','bin','pnpm-store','grid-reference','qualified-native','recipe','logs','downloads'}
    include_files={p.name for p in root.iterdir() if p.is_file() and p.suffix in ('.json','.txt')}
    def collect(path):
        if path.is_symlink() or path.is_file():members.append(path);return
        assert path.is_dir()
        members.append(path)
        for child in sorted(path.iterdir()):
            if child.name in ('.git','__pycache__'):continue
            if child.name=='node_modules' and child.relative_to(root).parts[0]=='source':continue
            collect(child)
    for name in sorted(include_dirs|include_files):
        p=root/name
        if p.exists():collect(p)
    assert len(members)<=200000
    total=sum(p.stat().st_size for p in members if p.is_file() and not p.is_symlink());assert total<=8*1024**3
    names={str(p.relative_to(root)) for p in members};manifest={}
    for p in members:
        rel=str(p.relative_to(root));mode=stat.S_IMODE(p.lstat().st_mode)
        if p.is_symlink():
            target=p.resolve(strict=True);assert target.is_relative_to(root)
            assert str(target.relative_to(root)) in names,'Payload link points into omitted inputs'
            manifest[rel]={'kind':'symlink','target':os.path.relpath(target,p.parent)}
        elif p.is_dir():manifest[rel]={'kind':'directory','mode':mode}
        else:manifest[rel]={'kind':'file','mode':mode,'size':p.stat().st_size,'sha256':sha(p)}
    archive=root/'inputs.tar.gz'
    with tarfile.open(archive,'w:gz') as tar:
        for p in members:
            rel=str(p.relative_to(root));entry=manifest[rel];info=tar.gettarinfo(str(p),arcname=rel)
            info.uid=info.gid=0;info.uname=info.gname=''
            if entry['kind']=='symlink':info.linkname=entry['target'];tar.addfile(info)
            elif entry['kind']=='file':
                info.type=tarfile.REGTYPE;info.linkname='';info.size=entry['size']
                with p.open('rb') as f:tar.addfile(info,f)
            else:tar.addfile(info)
    holder=pathlib.Path(tempfile.mkdtemp(prefix='payload-roundtrip-',dir=root/'tmp'))
    try:
        extracted=holder/'extracted';unpack(archive,extracted,max_files=200000,max_bytes=8*1024**3)
        for rel,entry in manifest.items():
            p=extracted/rel
            if entry['kind']=='symlink':
                assert p.is_symlink() and os.readlink(p)==entry['target']
                assert p.resolve(strict=True).is_relative_to(extracted)
            else:
                assert not p.is_symlink() and stat.S_IMODE(p.stat().st_mode)==entry['mode']
                if entry['kind']=='file':assert p.stat().st_size==entry['size'] and sha(p)==entry['sha256']
    finally:shutil.rmtree(holder)
    receipt={'archive':'inputs.tar.gz','sha256':sha(archive),'roundtripVerified':True,'members':manifest,'rebindRequired':True}
    (root/'payload-manifest.json').write_text(json.dumps(receipt,indent=2))
    return receipt
