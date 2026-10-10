"""Run: python3 -m unittest discover -s scripts/release/tests -v

Set HERDR_TEST_NFPM to a real nfpm (scripts/release/install-nfpm.sh) to also
build real packages; otherwise a stand-in records the generated configuration.
"""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "scripts/release"
VERSION = "20260920.3"
TARGETS = ("x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu")
EXTENSIONS = ("deb", "rpm", "pkg.tar.zst")
# Records each invocation and writes a placeholder package, or fails for the
# packager named in FAKE_NFPM_FAIL.
FAKE_NFPM = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
config = json.load(open(args[args.index("--config") + 1]))
packager = args[args.index("--packager") + 1]
with open(os.environ["FAKE_NFPM_LOG"], "a") as log:
    log.write(json.dumps({"packager": packager, "config": config}) + "\\n")
if os.environ.get("FAKE_NFPM_FAIL") == packager:
    sys.exit(1)
for entry in config["contents"]:
    open(entry["src"], "rb").close()
open(args[args.index("--target") + 1], "w").write(packager)
"""


class LinuxDistroTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="herdr-distro-test-")
        self.addCleanup(temp.cleanup)
        self.work = Path(temp.name)
        self.log = self.work / "nfpm.log"
        self.nfpm = self.work / "nfpm"
        self.nfpm.write_text(FAKE_NFPM)
        self.nfpm.chmod(0o755)
        self.env = {"PATH": os.environ["PATH"], "HOME": str(self.work), "FAKE_NFPM_LOG": str(self.log)}
        self.binary = self.work / "herdr-gpui"
        # package-linux.sh reads the release build identity the binary embeds.
        self.binary.write_bytes(b"not executable\0HERDR_BUILD_IDENTITY_V1\nworktree=0\nbranch=\npr=\n\0")
        self.notices = self.work / "notices.txt"
        self.notices.write_text("Third-party license text\n")

    def archive(self, target, directory=None):
        directory = directory or self.work / target
        directory.mkdir(exist_ok=True)
        result = subprocess.run(["bash", str(SCRIPTS / "package-linux.sh"), VERSION, target,
                                 str(self.binary), str(directory), str(self.notices)],
                                env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(result.stdout.strip())

    def package(self, target, archive, nfpm=None, success=True, **env):
        result = subprocess.run(["python3", str(SCRIPTS / "package-linux-distro.py"), VERSION, target,
                                 str(archive), str(archive.parent), "--nfpm", str(nfpm or self.nfpm)],
                                env={**self.env, **env}, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def outputs(self, target, directory):
        return [directory / f"Herdr-{VERSION}-{target}.{extension}" for extension in EXTENSIONS]

    def test_packages_install_the_manual_tree_under_usr(self):
        for target, arch in zip(TARGETS, ("amd64", "arm64")):
            with self.subTest(target=target):
                self.log.unlink(missing_ok=True)
                archive = self.archive(target)
                printed = self.package(target, archive).stdout.split()
                self.assertEqual([Path(p) for p in printed], [p.resolve() for p in self.outputs(target, archive.parent)])
                calls = [json.loads(line) for line in self.log.read_text().splitlines()]
                self.assertEqual([call["packager"] for call in calls], ["deb", "rpm", "archlinux"])
                config = calls[0]["config"]
                self.assertEqual((config["name"], config["arch"], config["version"], config["release"]),
                                 ("herdr-gpui", arch, VERSION, "1"))
                self.assertEqual(config["mtime"], "2026-09-20T00:00:00Z")
                with tarfile.open(archive) as source:
                    expected = {m.name.split("/", 1)[1] for m in source.getmembers() if m.isfile()}
                self.assertEqual({entry["dst"] for entry in config["contents"]},
                                 {f"/usr/{relative}" for relative in expected})
                modes = {entry["dst"]: entry["file_info"]["mode"] for entry in config["contents"]}
                self.assertEqual(modes.pop("/usr/bin/herdr-gpui"), 0o755)
                self.assertEqual(set(modes.values()), {0o644})
                depends = {packager: override["depends"] for packager, override in config["overrides"].items()}
                self.assertIn("libc6 (>= 2.39)", depends["deb"])
                self.assertIn("libc.so.6(GLIBC_2.39)(64bit)", depends["rpm"])
                self.assertIn("glibc>=2.39", depends["archlinux"])
                # GPUI's platform text support links Fontconfig at startup.
                self.assertIn("libfontconfig1", depends["deb"])
                self.assertIn("libfontconfig.so.1()(64bit)", depends["rpm"])
                self.assertIn("fontconfig", depends["archlinux"])
                # The dlopened loaders are hard requirements in every format.
                for packager, names in (("deb", ("libvulkan1", "libwayland-client0")),
                                        ("rpm", ("libvulkan.so.1()(64bit)", "libwayland-client.so.0()(64bit)")),
                                        ("archlinux", ("vulkan-icd-loader", "wayland"))):
                    for name in names:
                        self.assertIn(name, depends[packager])
                self.assertEqual(config["rpm"]["buildhost"], "herdr-gpui-release")
                self.assertEqual(sorted(p.name for p in archive.parent.iterdir()),
                                 sorted([archive.name, *(p.name for p in self.outputs(target, archive.parent))]))

    def test_refuses_to_overwrite_or_publish_a_partial_set(self):
        target = TARGETS[0]
        archive = self.archive(target)
        self.package(target, archive, success=False, FAKE_NFPM_FAIL="archlinux")
        self.assertEqual([p.name for p in archive.parent.iterdir()], [archive.name])
        existing = self.outputs(target, archive.parent)[1]
        existing.write_text("keep")
        self.assertIn("Output already exists", self.package(target, archive, success=False).stderr)
        self.assertEqual(existing.read_text(), "keep")
        self.assertEqual(sorted(p.name for p in archive.parent.iterdir()), sorted([archive.name, existing.name]))

    def test_rejects_bad_inputs(self):
        target = TARGETS[0]
        archive = self.archive(target)
        self.package("riscv64gc-unknown-linux-gnu", archive, success=False)
        self.package(TARGETS[1], archive, success=False)
        renamed = archive.with_name("other.tar.gz")
        renamed.write_bytes(archive.read_bytes())
        self.package(target, renamed, success=False)
        for bad in ("20260920.03", "v20260920.3"):
            result = subprocess.run(["python3", str(SCRIPTS / "package-linux-distro.py"), bad, target,
                                     str(archive), str(archive.parent), "--nfpm", str(self.nfpm)],
                                    env=self.env, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())

    def test_rejects_unexpected_archive_entries(self):
        target = TARGETS[0]
        prefix = f"Herdr-{VERSION}-{target}"
        with tarfile.open(self.archive(target)) as source:
            members = [(m, source.extractfile(m).read() if m.isfile() else None) for m in source.getmembers()]

        def rewrite(name, extra):
            directory = self.work / name
            directory.mkdir()
            path = directory / f"{prefix}.tar.gz"
            with tarfile.open(path, "w:gz") as output:
                for member, data in members:
                    output.addfile(member, io.BytesIO(data) if data is not None else None)
                extra(output)
            return path

        def link(output):
            entry = tarfile.TarInfo(f"{prefix}/share/extra")
            entry.type, entry.linkname = tarfile.SYMTYPE, "/etc/passwd"
            output.addfile(entry)

        def outside(output):
            entry = tarfile.TarInfo("elsewhere/file")
            entry.size = 1
            output.addfile(entry, io.BytesIO(b"x"))

        def added(output):
            entry = tarfile.TarInfo(f"{prefix}/share/extra")
            entry.size = 1
            output.addfile(entry, io.BytesIO(b"x"))

        for name, extra in (("link", link), ("outside", outside), ("added", added)):
            with self.subTest(name=name):
                path = rewrite(name, extra)
                self.package(target, path, success=False)
                self.assertEqual([p.name for p in path.parent.iterdir()], [path.name])

    def test_pinned_tools_and_images(self):
        installer = (SCRIPTS / "install-nfpm.sh").read_text()
        self.assertEqual(len(re.findall(r"sha=[0-9a-f]{64} ;;", installer)), 4)
        smoke = (SCRIPTS / "smoke-linux-packages.sh").read_text()
        images = re.findall(r"^(?:ubuntu|debian|fedora|arch)=(\S+)$", smoke, re.M)
        self.assertEqual(len(images), 4)
        for image in images:
            self.assertRegex(image, r"^[a-z]+:[a-z0-9.]+@sha256:[0-9a-f]{64}$")

    @unittest.skipUnless(os.environ.get("HERDR_TEST_NFPM"), "set HERDR_TEST_NFPM to a real nfpm")
    def test_real_nfpm_writes_each_format(self):
        magic = {"deb": b"!<arch>\n", "rpm": b"\xed\xab\xee\xdb", "pkg.tar.zst": b"\x28\xb5\x2f\xfd"}
        for target in TARGETS:
            with self.subTest(target=target):
                archive = self.archive(target)
                self.package(target, archive, nfpm=os.environ["HERDR_TEST_NFPM"])
                first = [path.read_bytes() for path in self.outputs(target, archive.parent)]
                for extension, data in zip(EXTENSIONS, first):
                    self.assertTrue(data.startswith(magic[extension]), extension)
                # The same archive and version must produce the same packages.
                again = self.work / f"again-{target}"
                again.mkdir()
                copy = again / archive.name
                copy.write_bytes(archive.read_bytes())
                self.package(target, copy, nfpm=os.environ["HERDR_TEST_NFPM"])
                self.assertEqual([path.read_bytes() for path in self.outputs(target, again)], first)


if __name__ == "__main__":
    unittest.main()
