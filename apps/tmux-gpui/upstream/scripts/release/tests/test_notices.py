"""Mock cargo-about and source fixtures: no network, builds, or signing."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "notices", Path(__file__).resolve().parents[1] / "generate-notices.py"
)
notices = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notices)


class NoticeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = dict(id="dep", name="dep", version="1.0.0", license="MIT",
                            source="registry+https://github.com/rust-lang/crates.io-index",
                            manifest_path=str(self.root / "Cargo.toml"), license_file=None)
        self.evidence = dict(
            crates=[dict(package=self.package, license="MIT")],
            licenses=[dict(name="MIT License", id="MIT", text="License text\nCopyright Alice\n",
                           source_path="/machine/local/LICENSE", used_by=[{"crate": self.package}])],
        )

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def test_sorted_complete_deterministic_report(self):
        self.write("LICENSE-MIT", "License text\nCopyright Alice\n")
        self.write("NOTICE", "Attribution\n")
        self.write("licenses/nested/LICENSE", "Additional terms\n")
        self.write("src/LICENSE", "Outside documented scope\n")
        other = dict(self.package, id="other", name="other")
        self.evidence["crates"].append(dict(package=other, license="MIT"))
        self.evidence["licenses"][0]["used_by"].append({"crate": other})
        first = notices.render(self.evidence, b"lock")
        self.evidence["crates"].reverse()
        self.evidence["licenses"][0]["used_by"].reverse()
        self.assertEqual(first, notices.render(self.evidence, b"lock"))
        self.assertIn("Packages (including workspace): 2", first)
        self.assertIn("Copyright Alice", first)
        self.assertIn("Attribution", first)
        self.assertIn("Additional terms", first)
        self.assertNotIn("Outside documented scope", first)
        self.assertNotIn(str(self.root), first)
        self.assertNotIn("/machine/local", first)
        self.assertIn("https://crates.io/api/v1/crates/dep/1.0.0/download", first)
        self.assertNotEqual(first, notices.render(self.evidence, b"new lock"))

    def test_canonical_text_and_notice_only_allowed_but_empty_file_fails(self):
        self.evidence["licenses"][0]["source_path"] = None
        report = notices.render(self.evidence, b"lock")
        self.assertIn("canonical SPDX text", report)
        self.assertIn("Copyright Alice", report)
        self.write("NOTICE", "Attribution")
        self.assertIn("Attribution", notices.render(self.evidence, b"lock"))
        self.write("NOTICE", "")
        with self.assertRaisesRegex(ValueError, "empty license/notice"):
            notices.render(self.evidence, b"lock")

    def test_explicit_license_file_is_required_even_with_other_license(self):
        self.write("LICENSE", "License text")
        self.package["license_file"] = "terms/custom.txt"
        with self.assertRaises(OSError):
            notices.collect(self.package)
        self.write("terms/custom.txt", "Explicit license")
        self.assertIn(("terms/custom.txt", "Explicit license"), notices.collect(self.package))

    def test_escaping_symlink_fails(self):
        (self.root / "LICENSE").symlink_to(Path(__file__).resolve())
        with self.assertRaisesRegex(ValueError, "escapes package"):
            notices.collect(self.package)

    def test_missing_unresolved_and_empty_evidence_fail(self):
        for field, value in [("crates", []), ("licenses", [])]:
            evidence = dict(self.evidence, **{field: value})
            with self.assertRaises(ValueError):
                notices.render(evidence, b"lock")
        for change in ("uncovered", "Unknown", "Ignore", "empty"):
            evidence = copy.deepcopy(self.evidence)
            if change == "uncovered":
                evidence["licenses"][0]["used_by"] = []
            elif change == "empty":
                evidence["licenses"][0]["text"] = " "
            else:
                evidence["crates"][0]["license"] = change
            with self.assertRaises(ValueError):
                notices.render(evidence, b"lock")

    def test_mpl_exceptions_are_version_specific(self):
        self.evidence["licenses"][0]["id"] = "MPL-2.0"
        self.package.update(name="option-ext", version="0.2.0")
        self.assertIn("option-ext/0.2.0/download", notices.render(self.evidence, b"lock"))
        self.package["version"] = "0.3.0"
        with self.assertRaisesRegex(ValueError, "MPL exception needs version review"):
            notices.render(self.evidence, b"lock")

    def cargo(self, command, **kwargs):
        if command == ["cargo", "about", "--version"]:
            return notices.subprocess.CompletedProcess(command, 0, notices.ABOUT_VERSION + "\n")
        return notices.subprocess.CompletedProcess(command, 0, notices.json.dumps(self.evidence).encode())

    def test_cli_locks_graph_and_never_writes_partial_or_overwrites(self):
        self.write("Cargo.lock", "locked dependencies")
        output = self.root / "report.txt"
        with patch.object(notices, "ROOT", self.root), \
             patch("sys.argv", ["generate-notices.py", str(output)]), \
             patch.object(notices.subprocess, "run", side_effect=self.cargo) as cargo:
            self.evidence["licenses"][0]["text"] = ""
            with self.assertRaisesRegex(ValueError, "empty license evidence"):
                notices.main()
            self.assertFalse(output.exists())
            self.assertEqual(cargo.call_args.args[0], [
                "cargo", "about", "generate", "--locked", "--all-features", "--workspace", "--fail",
                "--config", str(self.root / "scripts/release/about.toml"), "--format", "json",
            ])
            self.evidence["licenses"][0]["text"] = "Test license"
            with patch("builtins.print"):
                notices.main()
            report = output.read_bytes()
            cargo.reset_mock()
            with patch("sys.stderr"), self.assertRaises(SystemExit):
                notices.main()
            cargo.assert_not_called()
            self.assertEqual(output.read_bytes(), report)

    def test_changed_lockfile_fails_before_output(self):
        self.write("Cargo.lock", "original")
        output = self.root / "report.txt"
        def cargo(command, **kwargs):
            self.write("Cargo.lock", "changed")
            return self.cargo(command, **kwargs)

        with patch.object(notices, "ROOT", self.root), \
             patch("sys.argv", ["generate-notices.py", str(output)]), \
             patch.object(notices.subprocess, "run", side_effect=cargo):
            with self.assertRaisesRegex(ValueError, "Cargo.lock changed"):
                notices.main()
            self.assertFalse(output.exists())

    def test_tool_failure_partial_output_bad_json_and_wrong_version(self):
        self.write("Cargo.lock", "original")
        output = self.root / "report.txt"
        version = self.cargo(["cargo", "about", "--version"])
        cases = [
            [FileNotFoundError("cargo")],
            [notices.subprocess.CalledProcessError(101, "cargo about --version")],
            [notices.subprocess.CompletedProcess([], 0, "cargo-about 0.9.1")],
            [version, notices.subprocess.CalledProcessError(1, "cargo about generate", output=b"partial")],
            [version, notices.subprocess.CompletedProcess([], 0, b"not json")],
        ]
        for responses in cases:
            with self.subTest(responses=responses), \
                 patch.object(notices, "ROOT", self.root), \
                 patch("sys.argv", ["generate-notices.py", str(output)]), \
                 patch.object(notices.subprocess, "run", side_effect=responses):
                with self.assertRaises((OSError, ValueError, notices.subprocess.CalledProcessError)):
                    notices.main()
                self.assertFalse(output.exists())
