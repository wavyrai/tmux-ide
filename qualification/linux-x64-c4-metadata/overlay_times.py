"""Preserve timestamp-based bytecode validity; bytes are separately hash-verified."""
import pathlib,tarfile,os,math

def restore_overlay_times(archive,target):
 target=pathlib.Path(target).resolve();count=0
 with tarfile.open(archive) as tf:
  for m in tf.getmembers():
   name=pathlib.PurePosixPath(m.name);assert not name.is_absolute() and '..' not in name.parts
   assert m.isfile() or m.isdir(),'Link-free overlay required';assert math.isfinite(m.mtime)
   if m.isfile():
    p=target/name;assert not p.is_symlink() and p.is_file() and p.resolve().is_relative_to(target)
    before=p.stat();assert before.st_size==m.size
    os.utime(p,(m.mtime,m.mtime),follow_symlinks=False)
    assert p.stat().st_mode==before.st_mode;count+=1
 return {'regularFilesTimestampRestored':count,'bytesAndModesModified':False}
