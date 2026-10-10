#!/usr/bin/env python3
"""Apple-tool stand-ins: never access a keychain, network, or executable."""
import base64
import json
import os
from pathlib import Path
import shutil
import sys

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
if tool == "uname":
    assert args == ["-s"], args
    print(os.environ.get("MOCK_OS", "Darwin"))
    sys.exit(0)
with open(os.environ["MOCK_LOG"], "a") as log:
    log.write(json.dumps([tool, *args]) + "\n")
if os.environ.get("MOCK_FAIL") == tool:
    sys.exit(1)
if tool == "security":
    if args == ["list-keychains", "-d", "user"]:
        print('    "/mock/login keychain-db"\n    "/mock/system.keychain"')
    elif args[0] == "create-keychain":
        Path(args[-1]).touch()
    elif args[0] == "delete-keychain":
        Path(args[-1]).unlink()
elif tool == "openssl":
    print("dummy-temporary-password")
elif tool == "base64":
    assert args == ["-D"], args
    sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read(), validate=True))
elif tool == "plutil" and args[0] == "-extract":
    print("14.2" if args[1] == "LSMinimumSystemVersion" else "20260920.3")
elif tool == "lipo":
    if args[0] == "-archs":
        print(Path(args[1]).name)
    elif args[0] == "-create":
        Path(args[-1]).write_text("never execute this fixture")
    else:
        assert len(args) == 3 and args[1] == "-verify_arch" and args[2] in ("arm64", "x86_64"), args
        assert Path(args[0]).is_file(), args
elif tool == "ditto":
    if args[0] == "-c":
        Path(args[-1]).touch()
    else:
        shutil.copytree(args[0], args[1])
elif tool == "xcrun" and args[:2] == ["notarytool", "submit"]:
    print(os.environ.get("MOCK_NOTARY_JSON", '{"status":"Accepted"}'))
elif tool == "xcrun" and args[:2] == ["stapler", "staple"] and Path(args[-1]).is_dir():
    (Path(args[-1]) / "Contents/CodeResources").write_bytes(b"mock stapled ticket")
elif tool == "codesign" and args[0] == "--force" and Path(args[-1]).is_dir():
    signature = Path(args[-1]) / "Contents/_CodeSignature"
    signature.mkdir()
    (signature / "CodeResources").write_bytes(b"mock code signature")
elif tool == "hdiutil":
    image = Path(args[args.index("-srcfolder") + 1])
    assert (image / "Applications").is_symlink()
    assert os.readlink(image / "Applications") == "/Applications"
    assert (image / "Herdr.app").is_dir()
    Path(args[-1]).write_text("mock dmg")
