#!/usr/bin/env python3
"""Package an ordinary-file app; does not verify, sign, launch or publish it.

Adapted deterministic USTAR/gzip pattern from Herdr (Apache-2.0), pinned
302700e: scripts/update-manifest.py. No inherited endpoints, keys or versions.
Printable ASCII paths only; framework symlinks and special files unsupported.
Local source must remain quiescent. Metadata rechecks are not a hostile-writer
or hermetic-build guarantee. Failed output cleanup is limited to our own inode.
"""
import argparse
import gzip
import json
import os
from pathlib import Path
import re
import stat
import tarfile

COMPRESSED = 256 * 1024**2
EXPANDED = 1024**3
ENTRIES = 10000


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def inventory(app):
    result, aliases = [], set()
    total = 1024  # Two required end blocks; tarfile pads to a 10240-byte record.

    def visit(path, name):
        nonlocal total
        if len(result) >= ENTRIES:
            raise ValueError("entry limit exceeded")
        if (not re.fullmatch(r"[\x20-\x7e]+", name) or "\\" in name
                or any(part in ("", ".", "..") for part in name.split("/"))):
            raise ValueError("unsupported archive path")
        if name.lower() in aliases:
            raise ValueError("case alias rejected")
        aliases.add(name.lower())
        info = path.lstat()
        if info.st_mode & 0o7000:
            raise ValueError("special permission bits rejected")
        directory = stat.S_ISDIR(info.st_mode)
        if not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
            raise ValueError("links and special files rejected")
        member = tarfile.TarInfo(name)
        member.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
        member.mode = 0o755 if directory or info.st_mode & 0o111 else 0o644
        member.size = 0 if directory else info.st_size
        member.tobuf(format=tarfile.USTAR_FORMAT)  # Reject unrepresentable USTAR paths/sizes.
        total += 512 + ((member.size + 511) // 512) * 512
        if ((total + 10239) // 10240) * 10240 > EXPANDED:
            raise ValueError("expanded archive limit exceeded")
        result.append((path, member, identity(info)))
        if directory:
            for child in sorted(path.iterdir(), key=lambda item: item.name):
                visit(child, name + "/" + child.name)
    visit(app, "TmuxIDE.app")
    return result


class BoundedOutput:
    def __init__(self, output):
        self.output = output
        self.size = 0

    def write(self, data):
        if self.size + len(data) > COMPRESSED:
            raise ValueError("compressed archive limit exceeded")
        count = self.output.write(data)
        self.size += count
        return count

    def flush(self):
        self.output.flush()


def package(app, destination, version):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", version) or ".." in version:
        raise ValueError("invalid release version")
    app = Path(app).absolute()
    if app.is_symlink() or not app.is_dir():
        raise ValueError("app must be an ordinary directory")
    app = app.resolve(strict=True)
    requested = Path(destination).absolute()
    destination = requested.parent.resolve(strict=True) / requested.name
    if destination.name != f"tmux-ide-gpui-{version}-macos-arm64.app.tar.gz":
        raise ValueError("archive filename does not match version")
    if destination == app or app in destination.parents:
        raise ValueError("archive must be outside app")
    entries = inventory(app)
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    owned = os.fstat(fd)
    try:
        with os.fdopen(fd, "wb") as output:
            bounded = BoundedOutput(output)
            with gzip.GzipFile(filename="", mode="wb", fileobj=bounded, mtime=0) as zipped:
                with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                    for path, member, before in entries:
                        if identity(path.lstat()) != before:
                            raise ValueError("source changed")
                        if member.isdir():
                            archive.addfile(member)
                        else:
                            source_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                            with os.fdopen(source_fd, "rb") as source:
                                if identity(os.fstat(source.fileno())) != before:
                                    raise ValueError("source changed")
                                archive.addfile(member, source)
                                if identity(os.fstat(source.fileno())) != before:
                                    raise ValueError("source changed")
            if [(str(p), i) for p, _, i in inventory(app)] != [(str(p), i) for p, _, i in entries]:
                raise ValueError("source inventory changed")
        return {"archiveSize": destination.stat().st_size, "entries": len(entries)}
    except BaseException:
        current = destination.lstat()
        if current.st_dev == owned.st_dev and current.st_ino == owned.st_ino:
            destination.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.app, args.output, args.version)))
    except (OSError, ValueError, tarfile.TarError):
        parser.exit(1, "Archive packaging rejected; no signing or verification performed.\n")


if __name__ == "__main__":
    main()
