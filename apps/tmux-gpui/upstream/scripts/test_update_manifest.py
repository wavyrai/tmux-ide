"""Deterministic packaging tests; signing uses disposable keys only."""

import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("update_manifest", Path(__file__).with_name("update-manifest.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / "Herdr.app"
        self.app.mkdir()
        self.binary = self.app / "Herdr"
        self.binary.write_bytes(b"synthetic executable")
        self.binary.chmod(0o755)
        self.archive = self.root / "archive.tar.gz"

    def test_versions_and_names(self):
        for value in ("20260920.1", "10000101.99", "99991231.18446744073709551615"):
            self.assertEqual(updater.version(value), value)
        for value in ("20260920.01", "20260920.0", "20260920", "20260920.", "20260920.1.2",
                      "2026092.1", "202609201.1", "020260920.1", "1.2.3", "v20260920.1",
                      "２0260920.1", "20260920.1\n", "20260920.1-rc1", "20260920.1+build"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                updater.version(value)
        with self.assertRaises(ValueError):
            updater.asset_name("20260920.3", "../escape")
        with self.assertRaises(ValueError):
            updater.version("20260920.18446744073709551616")
        self.assertEqual(updater.asset_name("20260920.3", updater.TARGETS[0]),
                         "herdr-gpui-20260920.3-macos-universal.app.tar.gz")
        for target in updater.LINUX_TARGETS:
            self.assertEqual(updater.asset_name("20260920.3", target),
                             f"herdr-gpui-20260920.3-{target}-update.tar.gz")

    def test_macos_ustar_permissions_symlinks_and_stable_bytes(self):
        (self.app / "link").symlink_to("Herdr")
        updater.package_macos(self.app, self.archive)
        raw = gzip.decompress(self.archive.read_bytes())
        self.assertEqual(raw[257:265], b"ustar\x0000")
        with tarfile.open(self.archive) as archive:
            members = archive.getmembers()
            self.assertEqual([m.name for m in members], ["Herdr.app", "Herdr.app/Herdr", "Herdr.app/link"])
            self.assertEqual(members[1].mode, 0o755)
            self.assertEqual(members[2].linkname, "Herdr")
            self.assertTrue(members[2].issym())
            for member in members:
                self.assertEqual((member.uid, member.gid, member.uname, member.gname, member.mtime), (0, 0, "", "", 0))
                self.assertFalse(member.pax_headers)
        second = self.root / "second.tar.gz"
        updater.package_macos(self.app, second)
        self.assertEqual(self.archive.read_bytes(), second.read_bytes())
        with self.assertRaises(FileExistsError):
            updater.package_macos(self.app, second)

    def test_unsafe_entries_and_destinations(self):
        for target in ("../escape", "/etc/passwd", "a/../../escape", "bad\\path", "../Herdr.app/Herdr"):
            link = self.app / "link"
            link.symlink_to(target)
            with self.subTest(target=target), self.assertRaises((ValueError, OSError)):
                updater.package_macos(self.app, self.archive)
            self.assertFalse(self.archive.exists())
            link.unlink()
        with self.assertRaises(ValueError):
            updater.package_macos(self.app, self.app / "recursive.tar.gz")
        self.binary.chmod(0o4755)
        with self.assertRaises(ValueError):
            updater.package_macos(self.app, self.archive)
        self.binary.chmod(0o755)
        os.mkfifo(self.app / "fifo")
        with self.assertRaises(ValueError):
            updater.package_macos(self.app, self.archive)

    def test_ustar_rejects_extensions(self):
        (self.app / ("x" * 101)).write_bytes(b"x")
        with self.assertRaises(ValueError):
            updater.package_macos(self.app, self.archive)
        self.assertFalse(self.archive.exists())

    def test_archive_limits(self):
        for name, limit in (("ENTRY_LIMIT", 1), ("EXPANDED_LIMIT", 1), ("ARCHIVE_LIMIT", 1)):
            with self.subTest(limit=name), patch.object(updater, name, limit), self.assertRaises(ValueError):
                updater.package_macos(self.app, self.archive)
            self.assertFalse(self.archive.exists())
        with patch.object(updater, "EXPANDED_LIMIT", 1024), self.assertRaises(ValueError):
            updater.package_macos(self.app, self.archive)

    def test_cli_packaging_and_manifest(self):
        script = Path(__file__).with_name("update-manifest.py")

        def run(*args):
            return subprocess.run([sys.executable, str(script), *map(str, args)], capture_output=True, check=True)

        release = "20260920.3"
        run("package-macos", self.app, self.root / updater.asset_name(release, updater.TARGETS[0]))
        target = updater.LINUX_TARGETS[0]
        run("package-linux", self.binary, target, release, self.root / updater.asset_name(release, target))
        run("create", self.root, release)
        self.assertEqual(len(json.loads((self.root / "update-manifest.json").read_bytes())["assets"]), 2)
        (self.root / "update-manifest.json").unlink()
        missing = subprocess.run([sys.executable, str(script), "create", str(self.root), release,
                                  "--require-all-targets"], capture_output=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse((self.root / "update-manifest.json").exists())
        target = updater.LINUX_TARGETS[1]
        run("package-linux", self.binary, target, release, self.root / updater.asset_name(release, target))
        run("create", self.root, release, "--require-all-targets")
        self.assertEqual(len(json.loads((self.root / "update-manifest.json").read_bytes())["assets"]), 3)

    def test_linux_single_executable(self):
        self.binary.chmod(0o644)
        for target in updater.LINUX_TARGETS:
            archive_path = self.root / updater.asset_name("20260920.3", target)
            updater.package_linux(self.binary, target, "20260920.3", archive_path)
            self.assertEqual(gzip.decompress(archive_path.read_bytes())[257:265], b"ustar\x0000")
            with tarfile.open(archive_path) as archive:
                members = archive.getmembers()
                self.assertEqual(len(members), 1)
                self.assertEqual(members[0].name, f"herdr-gpui-20260920.3-{target}")
                self.assertEqual(members[0].mode, 0o755)
                self.assertTrue(members[0].isreg())
                self.assertEqual(archive.extractfile(members[0]).read(), self.binary.read_bytes())
        link = self.root / "link"
        link.symlink_to(self.binary)
        with self.assertRaises(ValueError):
            updater.package_linux(link, updater.LINUX_TARGETS[0], "20260920.3", self.archive)

    def test_manifest_exact_stable_bytes_and_optional_targets(self):
        release = "20260920.3"
        expected = []
        for target in updater.TARGETS:
            name = updater.asset_name(release, target)
            (self.root / name).write_bytes(b"abc")
            expected.append(dict(target=target, name=name, size=3, sha256=hashlib.sha256(b"abc").hexdigest()))
        for name in ("herdr-gpui-20260920.2-macos-universal.app.tar.gz", "herdr-gpui-20260920.3-unknown.tar.gz", "Herdr-20260920.3-x86_64-unknown-linux-gnu.tar.gz", "unrelated.zip"):
            (self.root / name).write_bytes(b"ignored")
        raw = updater.create(self.root, release)
        self.assertEqual(raw, json.dumps(dict(schema=1, version=release, assets=expected), separators=(",", ":")).encode())
        manifest = self.root / "update-manifest.json"
        self.assertEqual(manifest.read_bytes(), raw)
        manifest.unlink()
        self.assertEqual(updater.create(self.root, release), raw)
        manifest.unlink()
        for target in updater.LINUX_TARGETS:
            (self.root / updater.asset_name(release, target)).unlink()
        self.assertEqual(len(json.loads(updater.create(self.root, release))["assets"]), 1)
        manifest.unlink()
        with self.assertRaisesRegex(ValueError, "missing or non-regular archive"):
            updater.create(self.root, release, require_all_targets=True)
        self.assertFalse(manifest.exists())

    def test_manifest_requires_current_mac_and_bounded_regular_files(self):
        release = "20260920.3"
        with self.assertRaises(ValueError):
            updater.create(self.root, release)
        path = self.root / updater.asset_name(release, updater.TARGETS[0])
        path.write_bytes(b"")
        with self.assertRaises(ValueError):
            updater.create(self.root, release)
        with path.open("wb") as file:
            file.truncate(updater.ARCHIVE_LIMIT + 1)
        with self.assertRaises(ValueError):
            updater.create(self.root, release)
        path.unlink()
        path.symlink_to(self.binary)
        with self.assertRaises(ValueError):
            updater.create(self.root, release)
        path.unlink()
        path.write_bytes(b"abc")
        with patch.object(updater, "MANIFEST_LIMIT", 1), self.assertRaises(ValueError):
            updater.create(self.root, release)
        with patch.object(updater, "ARCHIVE_LIMIT", 3):
            updater.create(self.root, release)

    def test_public_key_shape(self):
        self.assertEqual(updater.public_key("ab" * 32), b"\xab" * 32)
        for value in ("", "AB" * 32, "a" * 63, "g" * 64, "a" * 64 + "\n"):
            with self.assertRaises(ValueError):
                updater.public_key(value)

    def test_ephemeral_ed25519_exact_bytes_and_key_match(self):
        openssl = os.environ.get("OPENSSL", shutil.which("openssl"))
        self.assertIsNotNone(openssl, "OpenSSL 3 is required for signing tests")

        def run(*args, check=True):
            return subprocess.run([openssl, *map(str, args)], check=check, capture_output=True)

        pem = self.root / "private.pem"
        pem.touch(mode=0o600)
        run("genpkey", "-algorithm", "ED25519", "-out", pem)
        der = run("pkey", "-in", pem, "-pubout", "-outform", "DER").stdout
        public = der[len(updater.ED25519_SPKI):].hex()
        updater.check_key(openssl, pem, public)
        with self.assertRaises(ValueError):
            updater.check_key(openssl, pem, "00" * 32)
        other = self.root / "other.pem"
        other.touch(mode=0o600)
        run("genpkey", "-algorithm", "X25519", "-out", other)
        with self.assertRaises(ValueError):
            updater.check_key(openssl, other, public)
        payload = self.root / "update-manifest.json"
        (self.root / updater.asset_name("20260920.3", updater.TARGETS[0])).write_bytes(b"abc")
        updater.create(self.root, "20260920.3")
        signature = self.root / "update-manifest.sig"
        run("pkeyutl", "-sign", "-rawin", "-inkey", pem, "-in", payload, "-out", signature)
        self.assertEqual(signature.stat().st_size, 64)
        public_pem = self.root / "public.pem"
        run("pkey", "-in", pem, "-pubout", "-out", public_pem)
        args = ("pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", public_pem, "-in", payload, "-sigfile", signature)
        run(*args)
        payload.write_bytes(payload.read_bytes() + b"\n")
        self.assertNotEqual(run(*args, check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
