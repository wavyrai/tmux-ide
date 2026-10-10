"""Run: python3 -m unittest discover -s scripts/release/tests -v"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts/release/generate-changelog.sh"
PREAMBLE = "GUI-only release."

MOCK_GIT_CLIFF = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["MOCK_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
section = "## [%s] - 2026-09-20\\n\\n### Added\\n- Mock entry\\n" % args[args.index("--tag") + 1]
if "--output" in args:
    with open(args[args.index("--output") + 1], "w") as output:
        output.write("# Changelog\\n\\n" + section)
else:
    sys.stdout.write(section)
"""


class ChangelogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herdr-changelog-test-")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.out = self.work / "out"
        self.out.mkdir()
        self.bin = self.work / "bin"
        self.bin.mkdir()
        mock = self.bin / "git-cliff"
        mock.write_text(MOCK_GIT_CLIFF)
        mock.chmod(0o755)
        self.log = self.work / "calls.jsonl"
        self.env = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
                    "HOME": str(self.work), "MOCK_LOG": str(self.log)}

    def generate(self, version="20260920.3", out=None, success=True):
        result = subprocess.run(["bash", str(SCRIPT), version, str(self.out if out is None else out)],
                                env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_release_body_leads_with_the_platform_facts_then_the_history(self):
        self.generate()
        notes = (self.out / "RELEASE_NOTES.md").read_text()
        head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
        self.assertTrue(notes.startswith(PREAMBLE), notes)
        self.assertIn(f"Source: {head}.", notes)
        self.assertIn("## [v20260920.3]", notes)
        self.assertIn("- Mock entry", notes)
        self.assertIn("# Changelog", (self.out / "CHANGELOG.md").read_text())

    def test_the_tag_being_cut_names_the_still_unreleased_commits(self):
        self.generate()
        changelog, notes = self.calls()
        self.assertNotIn("--unreleased", changelog)
        self.assertIn("--unreleased", notes)
        for call in (changelog, notes):
            self.assertEqual(call[call.index("--tag") + 1], "v20260920.3")
            self.assertEqual(call[call.index("--config") + 1], "cliff.toml")
        self.assertIn("--strip", notes)

    def test_bad_version_missing_directory_and_existing_output_refused(self):
        for version in ("v20260920.3", "20260920.3-rc1", "1.2", "020260920.3", "$(id)", ""):
            with self.subTest(version=version):
                self.generate(version=version, success=False)
        self.generate(out=self.work / "absent", success=False)
        self.assertFalse(self.log.exists())
        for name in ("CHANGELOG.md", "RELEASE_NOTES.md"):
            with self.subTest(name=name):
                shutil.rmtree(self.out)
                self.out.mkdir()
                (self.out / name).write_text("previous run\n")
                self.generate(success=False)
                self.assertEqual((self.out / name).read_text(), "previous run\n")

    def test_missing_git_cliff_is_named_rather_than_producing_half_a_release(self):
        (self.bin / "git-cliff").unlink()
        # Still a usable PATH for bash and git; only git-cliff is missing.
        self.env["PATH"] = os.pathsep.join([str(self.bin), "/usr/bin", "/bin"])
        result = self.generate(success=False)
        self.assertIn("git-cliff", result.stderr)
        self.assertEqual(list(self.out.iterdir()), [])


@unittest.skipUnless(shutil.which("git-cliff"), "git-cliff is not installed")
class RealChangelogTests(unittest.TestCase):
    def test_history_renders_conventional_types_into_keep_a_changelog_groups(self):
        with tempfile.TemporaryDirectory(prefix="herdr-changelog-real-") as temp:
            subprocess.run(["bash", str(SCRIPT), "20260920.3", temp],
                           capture_output=True, text=True, timeout=180, check=True)
            changelog = (Path(temp) / "CHANGELOG.md").read_text()
        self.assertIn("# Changelog", changelog)
        self.assertIn("## [v20260920.3]", changelog)
        # Merge commits and skipped types never reach a user-facing changelog.
        self.assertNotIn("Merge pull request", changelog)
        self.assertNotIn("### Chore", changelog)
        published = subprocess.run(["git", "-C", str(ROOT), "tag", "--list", "v20*"],
                                   capture_output=True, text=True, check=True).stdout.split()
        for tag in published:
            self.assertIn(f"## [{tag}]", changelog)

    def render(self, *messages):
        probes = [argument for message in messages for argument in ("--with-commit", message)]
        return subprocess.run(["git-cliff", "--config", "cliff.toml", "--unreleased",
                               "--tag", "v20260920.3", "--strip", "header", *probes],
                              cwd=ROOT, capture_output=True, text=True, timeout=180,
                              check=True).stdout.split("## [v20260920.3]")[0]

    def test_the_type_chooses_the_group_and_the_subject_is_the_entry(self):
        rendered = self.render("feat(sidebar): add a pinned section",
                               "fix: reject a truncated link",
                               "refactor: split the projection worker",
                               "docs: explain the socket path",
                               "fix(security): reject oversized frames",
                               "make the thing faster")
        self.assertIn("### Added\n- [sidebar] Add a pinned section", rendered)
        self.assertIn("### Fixed\n- Reject a truncated link", rendered)
        self.assertIn("### Changed\n- Split the projection worker\n- Make the thing faster", rendered)
        self.assertIn("### Security\n- [security] Reject oversized frames", rendered)
        self.assertIn("### Documentation\n- Explain the socket path", rendered)

    def test_housekeeping_is_hidden_unless_it_breaks_something(self):
        rendered = self.render("chore: bump a dependency", "ci: pin an action",
                               "build: raise the deployment target", "style: reformat",
                               "test: cover the parser")
        self.assertNotIn("###", rendered)
        # A breaking change reaches users whatever type carries it, and lands in
        # a real group rather than under a bare `chore` heading.
        for message in ("chore!: remove the deprecated flag",
                        "chore: retire the old config key\n\nBREAKING CHANGE: the key is gone."):
            with self.subTest(message=message):
                breaking = self.render(message)
                self.assertNotIn("### chore", breaking)
                self.assertIn("### Changed\n- **BREAKING:** ", breaking)

    def test_only_the_subject_line_reaches_the_release_body(self):
        rendered = self.render("feat: line one of the subject\n\nRationale users never read.")
        self.assertIn("- Line one of the subject\n", rendered)
        self.assertNotIn("Rationale", rendered)


if __name__ == "__main__":
    unittest.main()
