"""Exercise CI path selection against real Git histories."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "ci-changes.sh"


class CiChanges(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "commit", "--allow-empty", "-qm", "initial")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def commit_path(self, path):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixture\n")
        self.git("add", "--", path)
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "commit", "-qm", "fixture")

    def detect(self, event="pull_request", base=None):
        return subprocess.check_output(
            ["bash", str(SCRIPT)], cwd=self.root, text=True,
            env={**os.environ, "EVENT": event, "BASE": base or self.base,
                 "HEAD_SHA": self.git("rev-parse", "HEAD").strip()},
        ).strip()

    def test_documentation_and_setup_skip_native_jobs(self):
        for path in ("setup.sh", "README.md", "crates/herdr-gpui/README.md",
                     "scripts/release/README.md", "assets/social-preview-dark.png",
                     "assets/social-preview-light.svg", "assets/icons/herdr-ui-icon-badge.png",
                     "assets/icons/herdr-ui-icon-badge.svg"):
            self.commit_path(path)
            self.assertEqual(self.detect(), "code=false", path)

    def test_build_inputs_trigger_native_jobs(self):
        for path in ("crates/herdr-gpui/src/main.rs", "Cargo.lock", "Cargo.toml",
                     "assets/icon.png", "assets/icons/herdr-ui-icon-clean.png",
                     ".cargo/config.toml", "rust-toolchain.toml",
                     "scripts/release/build.sh", ".github/workflows/ci.yml"):
            self.base = self.git("rev-parse", "HEAD").strip()
            self.commit_path(path)
            self.assertEqual(self.detect(), "code=true", path)

    def test_deletions_trigger_native_jobs(self):
        self.commit_path("crates/example.rs")
        self.base = self.git("rev-parse", "HEAD").strip()
        self.git("rm", "crates/example.rs")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                 "commit", "-qm", "delete")
        self.assertEqual(self.detect(), "code=true")

    def test_manual_and_unknown_base_run_native_jobs(self):
        self.assertEqual(self.detect("workflow_dispatch"), "code=true")
        self.assertEqual(self.detect("push", "0" * 40), "code=true")

    def test_push_checks_entire_range(self):
        self.commit_path("crates/example.rs")
        self.commit_path("README.md")
        self.assertEqual(self.detect("push"), "code=true")

    def test_pull_request_ignores_base_branch_only_changes(self):
        self.git("checkout", "-qb", "base")
        self.commit_path("crates/base-only.rs")
        base_tip = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-qb", "topic", self.base)
        self.commit_path("setup.sh")
        self.assertEqual(self.detect(base=base_tip), "code=false")
