"""Read embedded identity without executing a possibly foreign-architecture binary."""
import mmap
from pathlib import Path
import re
import sys

PREFIX = b"\0HERDR_BUILD_IDENTITY_V1\n"
RECORD = re.compile(rb"worktree=([01])\nbranch=([^\x00-\x1f\x7f]*)\npr=([0-9]*)\n")


def identity(path):
    with open(path, "rb") as binary:
        with mmap.mmap(binary.fileno(), 0, access=mmap.ACCESS_READ) as data:
            records = set()
            start = data.find(PREFIX)
            while start != -1:
                body = start + len(PREFIX)
                end = data.find(b"\0", body, body + 4096)
                match = RECORD.fullmatch(data[body:end]) if end != -1 else None
                if not match:
                    raise ValueError(f"Malformed build identity: {path}")
                worktree, branch, pr = match.groups()
                if (worktree == b"0" and branch) or (worktree == b"1" and not branch) or (pr and not pr.strip(b"0")):
                    raise ValueError(f"Invalid build identity: {path}")
                records.add(match.groups())
                start = data.find(PREFIX, end + 1)
            if len(records) != 1:
                raise ValueError(f"Missing or conflicting build identity: {path}")
            return records.pop()


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("linux", "macos"):
        raise ValueError("Usage: python3 build-icon.py linux|macos BINARY [BINARY ...]")
    identities = {identity(path) for path in sys.argv[2:]}
    if len(identities) != 1:
        raise ValueError("Input binaries have different build identities")
    worktree, _, _ = identities.pop()
    icons = Path(__file__).resolve().parents[2] / "assets/icons"
    # macOS: the flattened .icns for CFBundleIconFile, then the Icon Composer
    # asset catalog for CFBundleIconName, which macOS 26 and later prefer.
    if sys.argv[1] == "macos":
        name = "Herdr-worktree" if worktree == b"1" else "Herdr"
        print(icons / f"{name}.icns", icons / f"{name}.car", sep="\n")
    # Linux: the source, then its path under the install prefix. Icon themes
    # only search the sizes their index lists, which stop at 512x512, so a
    # release installs the vector artwork as the scalable icon. The worktree
    # tint exists only as a PNG, so it goes to pixmaps, where lookup falls back.
    elif worktree == b"1":
        print(icons / "herdr-square-worktree-1024.png", "share/pixmaps/herdr-gpui.png", sep="\n")
    else:
        print(icons / "herdr-icon-square-clean.svg", "share/icons/hicolor/scalable/apps/herdr-gpui.svg", sep="\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        sys.exit(str(error))
