#!/usr/bin/env python3
"""One exact release asset contract, shared by publication and consumers."""

import argparse
import hashlib
import pathlib
import re


def base_names(version):
    if not re.fullmatch(r"[1-9][0-9]{7}\.[1-9][0-9]*", version):
        raise ValueError("Expected YYYYMMDD.COUNTER version")
    return [f"Herdr-{version}-universal-apple-darwin.dmg",
            f"Herdr-{version}-x86_64-unknown-linux-gnu.tar.gz",
            f"Herdr-{version}-x86_64-unknown-linux-gnu.deb",
            f"Herdr-{version}-x86_64-unknown-linux-gnu.rpm",
            f"Herdr-{version}-x86_64-unknown-linux-gnu.pkg.tar.zst",
            f"Herdr-{version}-aarch64-unknown-linux-gnu.tar.gz",
            f"Herdr-{version}-aarch64-unknown-linux-gnu.deb",
            f"Herdr-{version}-aarch64-unknown-linux-gnu.rpm",
            f"Herdr-{version}-aarch64-unknown-linux-gnu.pkg.tar.zst",
            f"Herdr-{version}-x86_64-pc-windows-msvc.zip",
            f"Herdr-{version}-aarch64-pc-windows-msvc.zip",
            f"Herdr-{version}.cdx.json",
            f"herdr-gpui-{version}-macos-universal.app.tar.gz",
            f"herdr-gpui-{version}-x86_64-unknown-linux-gnu-update.tar.gz",
            f"herdr-gpui-{version}-aarch64-unknown-linux-gnu-update.tar.gz",
            "update-manifest.json", "update-manifest.sig"]


def asset_names(version):
    return sorted(name + suffix for name in base_names(version)
                  for suffix in ("", ".sha256", ".sha512", ".sig", ".crt"))


def check_files(directory, names):
    files = list(directory.iterdir())
    if {p.name for p in files} != set(names) or any(
        p.is_symlink() or not p.is_file() or not p.stat().st_size for p in files
    ):
        raise ValueError("Missing, empty, symlink, or unexpected release artifact")
    if "update-manifest.sig" in names and (directory / "update-manifest.sig").stat().st_size != 64:
        raise ValueError("Updater signature must be raw 64-byte Ed25519")


def digest(path, algorithm):
    with path.open("rb") as source:
        return hashlib.file_digest(source, algorithm).hexdigest()


def verify_manifest(directory, version):
    entries = {}
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
        if not match or match[2] in entries:
            raise ValueError("Malformed or duplicate checksum entry")
        entries[match[2]] = match[1]
    if set(entries) != set(asset_names(version)):
        raise ValueError("Unexpected checksum manifest")
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("base", "create", "verify", "dmg", "names", "base-names"))
    parser.add_argument("version")
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    directory, version = args.directory, args.version
    names = asset_names(version)
    if args.mode == "base-names":
        print("\n".join(base_names(version)))
        return
    if args.mode == "names":
        print("\n".join(names + ["SHA256SUMS"]))
        return
    if args.mode == "base":
        check_files(directory, base_names(version))
        return
    if args.mode == "dmg":
        entries = verify_manifest(directory, version)
        name = base_names(version)[0]
        check_files(directory, [name, "SHA256SUMS"])
        actual = digest(directory / name, "sha256")
        if actual != entries[name]:
            raise ValueError("Final DMG checksum mismatch")
        print(actual)
        return
    check_files(directory, names + ([] if args.mode == "create" else ["SHA256SUMS"]))
    for name in base_names(version):
        for algorithm in ("sha256", "sha512"):
            expected = f"{digest(directory / name, algorithm)}  {name}\n"
            if (directory / f"{name}.{algorithm}").read_text() != expected:
                raise ValueError(f"Invalid {algorithm} sidecar: {name}")
    if args.mode == "create":
        with (directory / "SHA256SUMS").open("x") as output:
            for name in names:
                output.write(f"{digest(directory / name, 'sha256')}  {name}\n")
    else:
        for name, expected in verify_manifest(directory, version).items():
            if digest(directory / name, "sha256") != expected:
                raise ValueError(f"Checksum mismatch: {name}")


if __name__ == "__main__":
    main()
