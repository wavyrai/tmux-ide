#!/usr/bin/env python3
"""Package updater archives and emit the exact schema-1 authentication payload."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile

ARCHIVE_LIMIT = 268435456
EXPANDED_LIMIT = 1073741824
ENTRY_LIMIT = 10000
MANIFEST_LIMIT = 65536
LINUX_TARGETS = ("x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu")
TARGETS = ("universal-apple-darwin", *LINUX_TARGETS)
ED25519_SPKI = bytes.fromhex("302a300506032b6570032100")


def version(value):
    """Calendar version: an eight-digit YYYYMMDD date and a same-day counter."""
    if not re.fullmatch(r"[1-9][0-9]{7}\.[1-9][0-9]*", value):
        raise ValueError("version must be YYYYMMDD.COUNTER without leading zeros")
    if any(int(component) > 2**64 - 1 for component in value.split(".")):
        raise ValueError("version components must fit unsigned 64-bit integers")
    return value


def public_key(value):
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("HERDR_UPDATE_PUBLIC_KEY must be 64 lowercase hex characters")
    return bytes.fromhex(value)


def check_key(openssl, pem, public):
    expected = ED25519_SPKI + public_key(public)
    actual = subprocess.run(
        [openssl, "pkey", "-in", str(pem), "-passin", "pass:", "-pubout", "-outform", "DER"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ).stdout
    if actual != expected:
        raise ValueError("signing key is not the configured Ed25519 public key")


def asset_name(release, target):
    version(release)
    if target not in TARGETS:
        raise ValueError("unsupported target")
    suffix = "macos-universal.app" if target == TARGETS[0] else f"{target}-update"
    return f"herdr-gpui-{release}-{suffix}.tar.gz"


def package(entries, destination, linux=False):
    """Never dereference symlinks or encode hardlinks/extended tar headers."""
    destination = Path(destination)
    count = total = 0
    # Exclusive creation prevents overwriting either inputs or existing releases.
    with destination.open("xb") as output:
        try:
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as zipped:
                with tarfile.open(fileobj=zipped, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                    for path, name in entries:
                        count += 1
                        if count > ENTRY_LIMIT:
                            raise ValueError("archive exceeds entry limit")
                        info = path.lstat()
                        member = tarfile.TarInfo(name)
                        member.mode = stat.S_IMODE(info.st_mode)
                        if member.mode & 0o7000:
                            raise ValueError("special permission bits are not supported")
                        if stat.S_ISREG(info.st_mode):
                            member.size = info.st_size
                            total += member.size
                            if total > EXPANDED_LIMIT:
                                raise ValueError("archive exceeds expanded size limit")
                            if linux:
                                member.mode = 0o755
                            with path.open("rb") as source:
                                archive.addfile(member, source)
                        elif stat.S_ISDIR(info.st_mode) and not linux:
                            member.type = tarfile.DIRTYPE
                            archive.addfile(member)
                        elif stat.S_ISLNK(info.st_mode) and not linux:
                            member.type = tarfile.SYMTYPE
                            member.linkname = os.readlink(path)
                            if os.path.isabs(member.linkname) or "\\" in member.linkname:
                                raise ValueError("symlink must stay inside Herdr.app")
                            depth = len(name.split("/")) - 1
                            for part in member.linkname.split("/"):
                                if part == "..":
                                    depth -= 1
                                elif part not in ("", "."):
                                    depth += 1
                                if depth < 1:
                                    raise ValueError("symlink must stay inside Herdr.app")
                            archive.addfile(member)
                        else:
                            raise ValueError("archive contains unsupported file type")
                        # Include USTAR headers, file padding, end markers and record padding.
                        expanded = ((archive.offset + 1024 + 10239) // 10240) * 10240
                        if expanded > EXPANDED_LIMIT:
                            raise ValueError("archive exceeds expanded size limit including headers")
            if not 1 <= output.tell() <= ARCHIVE_LIMIT:
                raise ValueError("archive exceeds compressed size limit")
        except BaseException:
            destination.unlink()
            raise


def package_macos(app, destination):
    app = Path(app)
    if app.name != "Herdr.app" or app.is_symlink() or not app.is_dir():
        raise ValueError("app must be a real Herdr.app directory")
    if Path(destination).resolve().is_relative_to(app.resolve()):
        raise ValueError("archive destination must be outside the app")

    def entries(directory):
        yield directory, directory.relative_to(app.parent).as_posix()
        for child in sorted(directory.iterdir()):
            if child.is_symlink() and not child.resolve(strict=True).is_relative_to(app.resolve()):
                raise ValueError("symlink chain must stay inside Herdr.app")
            if child.is_dir() and not child.is_symlink():
                yield from entries(child)
            else:
                yield child, child.relative_to(app.parent).as_posix()

    package(entries(app), destination)


def package_linux(binary, target, release, destination):
    version(release)
    name = f"herdr-gpui-{release}-{target}"
    if target not in LINUX_TARGETS:
        raise ValueError("package-linux requires a supported Linux target")
    package([(Path(binary), name)], destination, linux=True)


def create(directory, release, require_all_targets=False):
    directory = Path(directory)
    assets = []
    for target in TARGETS:
        name = asset_name(release, target)
        path = directory / name
        if not require_all_targets and not path.exists() and not path.is_symlink() and target != TARGETS[0]:
            continue
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"missing or non-regular archive: {name}")
        size = path.stat().st_size
        if not 1 <= size <= ARCHIVE_LIMIT:
            raise ValueError(f"archive size outside permitted bounds: {name}")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(65536), b""):
                digest.update(chunk)
        assets.append(dict(target=target, name=name, size=size, sha256=digest.hexdigest()))
    payload = json.dumps(dict(schema=1, version=release, assets=assets), separators=(",", ":")).encode("ascii")
    if len(payload) > MANIFEST_LIMIT:
        raise ValueError("manifest exceeds 64 KiB")
    with (directory / "update-manifest.json").open("xb") as output:
        output.write(payload)
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    mac = commands.add_parser("package-macos")
    mac.add_argument("app")
    mac.add_argument("archive")
    linux = commands.add_parser("package-linux")
    linux.add_argument("binary")
    linux.add_argument("target", choices=LINUX_TARGETS)
    linux.add_argument("version")
    linux.add_argument("destination")
    manifest = commands.add_parser("create")
    manifest.add_argument("directory")
    manifest.add_argument("version")
    manifest.add_argument("--require-all-targets", action="store_true")
    commands.add_parser("validate-public-key")
    key = commands.add_parser("check-key")
    key.add_argument("openssl")
    key.add_argument("pem")
    args = parser.parse_args()
    try:
        if args.command == "package-macos":
            package_macos(args.app, args.archive)
        elif args.command == "package-linux":
            package_linux(args.binary, args.target, args.version, args.destination)
        elif args.command == "create":
            create(args.directory, args.version, args.require_all_targets)
        elif args.command == "validate-public-key":
            public_key(os.environ.get("HERDR_UPDATE_PUBLIC_KEY", ""))
        else:
            check_key(args.openssl, args.pem, os.environ.get("HERDR_UPDATE_PUBLIC_KEY", ""))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"update packaging failed: {error}\n")


if __name__ == "__main__":
    main()
