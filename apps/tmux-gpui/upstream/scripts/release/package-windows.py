#!/usr/bin/env python3
"""Package the experimental Windows executable as Herdr-VERSION-TARGET.zip.

Pure standard library so the Windows runner needs no zip tool. The layout
mirrors package-linux.sh: the executable plus the same license and notice files.
"""
import argparse
from pathlib import Path
import re
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
TARGETS = ("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")
LICENSES = ("LICENSE", "NOTICE", "assets/icons/LICENSE-octicons",
            "crates/herdr-protocol/LICENSE-APACHE", "crates/herdr-protocol/NOTICE.md",
            "crates/herdr-gpui/SOUND-NOTICE.md")
# Zip cannot store dates before 1980; a fixed stamp keeps entries independent
# of checkout and build times.
TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def add(archive, name, data):
    info = zipfile.ZipInfo(name, TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    archive.writestr(info, data)


def package(version, target, binary, output_dir, notices):
    if not re.fullmatch(r"[1-9][0-9]{7}\.[1-9][0-9]*", version):
        raise ValueError("Version must be YYYYMMDD.COUNTER (no v prefix, counter from 1, no leading zeros)")
    if target not in TARGETS:
        raise ValueError("Unsupported Windows target")
    if not binary.is_file() or not output_dir.is_dir():
        raise ValueError("Binary file and existing output directory required")
    if not notices.is_file() or not notices.stat().st_size:
        raise ValueError("Nonempty third-party notices file required")
    name = f"Herdr-{version}-{target}"
    output = output_dir.resolve() / f"{name}.zip"
    if output.exists() or output.is_symlink():
        raise ValueError(f"Output already exists: {output}")
    # Build beside the output and rename, so a failure never leaves a partial zip.
    with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".herdr-windows.", delete=False) as temp:
        partial = Path(temp.name)
    try:
        with zipfile.ZipFile(partial, "w") as archive:
            add(archive, f"{name}/herdr-gpui.exe", binary.read_bytes())
            for source in LICENSES:
                add(archive, f"{name}/licenses/{Path(source).name}", (ROOT / source).read_bytes())
            add(archive, f"{name}/licenses/THIRD-PARTY-NOTICES.txt", notices.read_bytes())
        if output.exists() or output.is_symlink():
            raise ValueError(f"Output already exists: {output}")
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("target")
    parser.add_argument("binary", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("notices", type=Path)
    args = parser.parse_args()
    print(package(args.version, args.target, args.binary, args.output_dir, args.notices))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
