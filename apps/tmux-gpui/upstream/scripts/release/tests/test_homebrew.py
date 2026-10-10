"""Local Git integration with mocked HTTPS/SSH transport; never contacts GitHub."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "update-homebrew.sh"


class HomebrewTests(unittest.TestCase):
    def test_publish_and_failures(self):
        existing_versions = {
            "old-job-rerun": "20260920.4", "lower-date": "20260921.1",
            "lower-counter": "20260920.10", "upgrade-counter": "20260920.2",
            "upgrade-date": "20260919.9", "upgrade-old-date": "20250101.1",
            "upgrade-numeric": "20260920.9",
            "large-component": "20260920.18446744073709551616",
            "leading-zero": "020260920.3", "prerelease": "20260920.3-rc.1",
            "legacy-semver": "0.1.0", "legacy-leading-zero": "01.2.3",
            "invalid-existing": "garbage",
        }
        successes = ("publish", "unchanged", "upgrade-counter", "upgrade-date",
                     "upgrade-old-date", "upgrade-numeric", "legacy-semver")
        for case in ("publish", "unchanged", "missing-key", "bad-version", "symlink",
                     "curl", "clone", "push", "bad-meta", "directory", "diff-error",
                     "version-mismatch", "missing-cask", "changed-checksum", "changed-content",
                     "missing-version", "duplicate-version", "ruby-version", *existing_versions):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                work = Path(directory)
                tools = work / "tools"
                tools.mkdir()
                temporary = work / "temporary"
                temporary.mkdir()
                env = {"PATH": str(tools) + os.pathsep + os.environ["PATH"],
                       "HOME": directory, "GIT_CONFIG_NOSYSTEM": "1",
                       "RUNNER_TEMP": str(temporary), "CASE": case,
                       "HOMEBREW_TAP_SSH_KEY": "dummy-private-key",
                       "REAL_GIT": shutil.which("git"), "WORK": directory,
                       "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
                       "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com"}

                def git(*args):
                    return subprocess.check_output([env["REAL_GIT"], *map(str, args)],
                                                   env=env, stderr=subprocess.PIPE, text=True)

                seed = work / "seed"
                git("init", "--initial-branch=trunk", seed)
                (seed / "README.md").write_text("Preserve this file\n")
                cask = work / "rendered.rb"
                cask.write_text('cask "herdr-gpui" do\n  version "20260920.3"\n  sha256 "' + "a" * 64 + '"\nend\n')
                if case in existing_versions or case in (
                        "unchanged", "changed-checksum", "changed-content", "missing-version",
                        "duplicate-version", "ruby-version"):
                    (seed / "Casks").mkdir()
                    content = cask.read_text()
                    if case in existing_versions:
                        content = content.replace('"20260920.3"', '"' + existing_versions[case] + '"')
                    elif case == "changed-checksum":
                        content = content.replace("a" * 64, "b" * 64)
                    elif case == "changed-content":
                        content += "# different content\n"
                    elif case == "missing-version":
                        content = content.replace('  version "20260920.3"\n', "")
                    elif case == "duplicate-version":
                        content += '  version "20260920.3"\n'
                    elif case == "ruby-version":
                        content = content.replace('"20260920.3"', '`touch "' + str(work / "executed") + '"`')
                    (seed / "Casks/herdr-gpui.rb").write_text(content)
                version = "20260920.10" if case == "upgrade-numeric" else "20260920.3"
                if case == "upgrade-numeric":
                    cask.write_text(cask.read_text().replace('"20260920.3"', '"20260920.10"'))
                if case == "symlink":
                    (seed / "Casks").symlink_to(".")
                if case == "directory":
                    (seed / "Casks/herdr-gpui.rb").mkdir(parents=True)
                    (seed / "Casks/herdr-gpui.rb/keep").touch()
                if case == "version-mismatch":
                    cask.write_text('  version "20260920.9"\n')
                if case == "missing-cask":
                    cask.unlink()
                git("-C", seed, "add", ".")
                git("-C", seed, "-c", "commit.gpgSign=false", "commit", "-m", "initial")
                remote = work / "remote.git"
                git("clone", "--bare", seed, remote)
                before = git("--git-dir", remote, "rev-parse", "HEAD")
                mock = tools / "mock"
                mock.write_text('''#!/usr/bin/env python3
import json, os, pathlib, stat, subprocess, sys
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
work = pathlib.Path(os.environ["WORK"])
case = os.environ["CASE"]
assert "HOMEBREW_TAP_SSH_KEY" not in os.environ
if tool == "curl":
    assert "https://api.github.com/meta" in args
    assert args[args.index("--proto") + 1] == "=https"
    if case == "curl": sys.exit(22)
    print(json.dumps({"ssh_keys": [] if case == "bad-meta" else ["ssh-ed25519 dummy"]}))
    sys.exit(0)
if "clone" in args:
    temp = pathlib.Path(args[-1]).parent
    assert stat.S_IMODE((temp / "key").stat().st_mode) == 0o600
    assert stat.S_IMODE(temp.stat().st_mode) == 0o700
    ssh = os.environ["GIT_SSH_COMMAND"]
    for option in ["IdentitiesOnly=yes", "IdentityAgent=none", "StrictHostKeyChecking=yes",
                   "BatchMode=yes", "-F /dev/null", "GlobalKnownHostsFile=/dev/null"]:
        assert option in ssh
    assert (temp / "known_hosts").read_text() == "github.com ssh-ed25519 dummy\\n"
    assert args[-2] == "git@github.com:penso/homebrew-tap.git"
    if case == "clone": sys.exit(1)
    args[-2] = str(work / "remote.git")
if "push" in args:
    assert args[-1] == "HEAD:refs/heads/trunk"
    if case == "push": sys.exit(1)
if "diff" in args and case == "diff-error": sys.exit(2)
if case == "unchanged":
    assert "commit" not in args and "push" not in args
sys.exit(subprocess.call([os.environ["REAL_GIT"], *args]))
''')
                mock.chmod(0o755)
                for tool in ("git", "curl"):
                    (tools / tool).symlink_to(mock)
                if case == "missing-key":
                    del env["HOMEBREW_TAP_SSH_KEY"]
                result = subprocess.run(
                    ["bash", str(SCRIPT), "020260920.3" if case == "bad-version" else version, str(cask)],
                    env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode == 0, case in successes, result.stderr)
                if case in ("old-job-rerun", "lower-date", "lower-counter", "large-component"):
                    self.assertIn("Refusing Homebrew downgrade", result.stderr)
                if case == "legacy-semver":
                    self.assertIn("Replacing pre-calendar cask version 0.1.0", result.stdout)
                if case in ("changed-checksum", "changed-content"):
                    self.assertIn("Same cask version has different content", result.stderr)
                if case == "unchanged":
                    self.assertIn("already up to date", result.stdout)
                self.assertFalse((work / "executed").exists())
                self.assertNotIn("dummy-private-key", result.stdout + result.stderr)
                self.assertEqual(list(temporary.iterdir()), [])
                after = git("--git-dir", remote, "rev-parse", "HEAD")
                self.assertEqual(before == after, case not in successes or case == "unchanged")
                if case in successes and case != "unchanged":
                    self.assertEqual(git("--git-dir", remote, "diff-tree", "--no-commit-id",
                                         "--name-only", "-r", "HEAD").strip(), "Casks/herdr-gpui.rb")
                    self.assertEqual(git("--git-dir", remote, "log", "-1", "--format=%s").strip(),
                                     "chore: release herdr-gpui " + version)
