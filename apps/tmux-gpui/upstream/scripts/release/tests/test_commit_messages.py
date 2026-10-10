"""Run: python3 -m unittest discover -s scripts/release/tests -v"""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
CHECKER = ROOT / "scripts/release/check-commit-messages.py"
SPEC = importlib.util.spec_from_file_location("check_commit_messages", CHECKER)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class RuleTests(unittest.TestCase):
    def assertAccepted(self, message):
        self.assertEqual(CHECK.problems(message), [], message)

    def assertRejected(self, message, expected):
        found = " ".join(CHECK.problems(message))
        self.assertNotEqual(found, "", message)
        self.assertIn(expected, found)

    def test_every_published_and_hidden_type_is_accepted(self):
        for name in list(CHECK.PUBLISHED_TYPES) + list(CHECK.HIDDEN_TYPES):
            with self.subTest(type=name):
                self.assertAccepted(f"{name}: change something worth a sentence")
                self.assertAccepted(f"{name}(sidebar): change something worth a sentence")
                self.assertAccepted(f"{name}!: change something worth a sentence")

    def test_a_subject_that_would_land_in_the_wrong_section_is_refused(self):
        for subject in ("Added a pinned sidebar section", "wip", "feature: add a pinned section",
                        "Feat: add a pinned section", "feat add a pinned section", "feat:no space"):
            with self.subTest(subject=subject):
                self.assertRejected(subject, "`type: description`")

    def test_entry_text_rules_match_what_the_release_page_prints(self):
        self.assertRejected("feat: add a pinned sidebar section.", "Drop the full stop")
        self.assertRejected("fix: typo", "at least")
        self.assertRejected("feat: " + "a" * CHECK.MAX_SUBJECT, "keep it within")
        self.assertAccepted("feat: " + "a" * (CHECK.MAX_SUBJECT - len("feat: ")))

    def test_the_body_must_stay_below_a_blank_line(self):
        self.assertRejected("feat: add a pinned sidebar section\nRationale follows", "line 2 blank")
        self.assertAccepted("feat: add a pinned sidebar section\n\nRationale follows.")

    def test_a_misspelled_breaking_footer_would_publish_as_an_ordinary_entry(self):
        for footer in ("Breaking change: the key is gone.", "breaking-change: the key is gone."):
            with self.subTest(footer=footer):
                self.assertRejected(f"chore: retire the old config key\n\n{footer}", "BREAKING CHANGE:")
        for footer in ("BREAKING CHANGE: the key is gone.", "BREAKING-CHANGE: the key is gone."):
            with self.subTest(footer=footer):
                self.assertAccepted(f"chore: retire the old config key\n\n{footer}")

    def test_prose_may_begin_with_the_words_of_a_footer(self):
        self.assertAccepted("ci: check the commit subjects\n\nA misspelled footer publishes a\n"
                            "breaking change as an ordinary entry.")

    def test_git_writes_some_subjects_itself_and_they_are_left_alone(self):
        for subject in ("Merge pull request #59 from penso/worktree/green-harbor-a063",
                        "Merge branch 'main' into feature", 'Revert "feat: add a pinned section"',
                        "fixup! feat: add a pinned section", "squash! feat: add a pinned section"):
            with self.subTest(subject=subject):
                self.assertAccepted(subject)

    def test_comments_and_the_verbose_diff_are_not_part_of_the_message(self):
        self.assertAccepted("feat: add a pinned sidebar section\n"
                            "# Please enter the commit message for your changes.\n"
                            "# On branch main\n")
        self.assertAccepted(f"feat: add a pinned sidebar section\n\n{CHECK.SCISSORS}\n"
                            "diff --git a/x b/x\n+Added a line.\n")
        self.assertRejected("# everything was a comment\n", "empty")

    def test_this_repository_already_obeys_every_rule(self):
        first = subprocess.run(["git", "-C", str(ROOT), "rev-list", "--max-parents=0", "HEAD"],
                               capture_output=True, text=True, check=True).stdout.split()[0]
        result = subprocess.run(["python3", str(CHECKER), "range", f"{first}..HEAD"],
                                cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)


class HookTests(unittest.TestCase):
    """The hook must refuse a commit, not report one after it exists."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herdr-hook-test-")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        subprocess.run(["git", "init", "--quiet", "--initial-branch=main", str(self.work)], check=True)
        for key, value in (("user.name", "Test"), ("user.email", "test@example.com"),
                           ("commit.gpgsign", "false"), ("core.hooksPath", ".githooks")):
            subprocess.run(["git", "-C", str(self.work), "config", key, value], check=True)
        shutil.copytree(ROOT / ".githooks", self.work / ".githooks")
        (self.work / "scripts/release").mkdir(parents=True)
        shutil.copyfile(CHECKER, self.work / "scripts/release/check-commit-messages.py")

    def commit(self, message):
        return subprocess.run(["git", "-C", str(self.work), "commit", "--allow-empty", "-m", message],
                              capture_output=True, text=True, timeout=60)

    def subjects(self):
        log = subprocess.run(["git", "-C", str(self.work), "log", "--format=%s"],
                             capture_output=True, text=True)
        return log.stdout.split("\n") if log.returncode == 0 else []

    def test_a_bad_subject_never_becomes_a_commit(self):
        result = self.commit("Added a pinned sidebar section")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("`type: description`", result.stderr)
        self.assertEqual(self.subjects(), [])

    def test_a_good_subject_commits_normally(self):
        result = self.commit("feat: add a pinned sidebar section")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("feat: add a pinned sidebar section", self.subjects())


if __name__ == "__main__":
    unittest.main()
