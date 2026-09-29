"""Bounded copies of explicit private Homebrew logs; never retry installation."""
import hashlib, json, os, pathlib, stat
FORMULAS=('openssl@3','libevent','ncurses','utf8proc','automake','autoconf','pkgconf','cmake','ca-certificates')
FILE_CAP=256*1024
TOTAL_CAP=8*1024*1024
COUNT_CAP=64

def capture_logs(source, destination):
    source=pathlib.Path(source);destination=pathlib.Path(destination)
    destination.mkdir(mode=0o700)
    receipt={'files':[], 'errors':[], 'bytes':0, 'fileCap':FILE_CAP,'totalCap':TOTAL_CAP,'countCap':COUNT_CAP}
    if source.is_symlink():raise ValueError('Symlink log root')
    for formula in FORMULAS:
        directory=source/formula
        if not directory.exists():continue
        if directory.is_symlink() or not directory.is_dir():
            receipt['errors'].append({'formula':formula,'code':'unsafe-directory'});continue
        # Homebrew formula logs are direct children; never recurse or follow links.
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                if index>=1024:
                    receipt['errors'].append({'formula':formula,'code':'entry-cap'});break
                if len(receipt['files'])>=COUNT_CAP or receipt['bytes']>=TOTAL_CAP:
                    receipt['errors'].append({'formula':formula,'code':'capture-cap'});break
                try:
                    fd=os.open(entry.path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                    try:
                        observed=os.fstat(fd)
                        if not stat.S_ISREG(observed.st_mode):raise ValueError('Not regular')
                        limit=min(FILE_CAP,TOTAL_CAP-receipt['bytes'])
                        offset=max(0,observed.st_size-limit)
                        os.lseek(fd,offset,os.SEEK_SET);data=os.read(fd,limit)
                    finally:os.close(fd)
                    name=f'{len(receipt["files"]):02d}.log'
                    (destination/name).write_bytes(data)
                    receipt['files'].append({'formula':formula,'sourceName':entry.name,'copy':name,'sourceBytes':observed.st_size,'offset':offset,'bytes':len(data),'truncated':offset>0,'sha256':hashlib.sha256(data).hexdigest()})
                    receipt['bytes']+=len(data)
                except (OSError,ValueError):
                    if len(receipt['errors'])<128:receipt['errors'].append({'formula':formula,'code':'unsafe-or-unreadable-file'})
    (destination/'receipt.json').write_text(json.dumps(receipt,indent=2))
    return receipt

def with_diagnostics(action, capture, save):
    """Collection errors cannot replace the installer's exception or success."""
    try:return action()
    finally:
        try:
            result=capture();status={'ok':not result['errors'],'errors':result['errors']}
        except Exception:
            status={'ok':False,'errors':[{'code':'capture-failed'}]}
        try:save(status)
        except Exception:pass # The original installer result retains precedence.
