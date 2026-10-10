"""Calendar version derivation; no network, no repository state."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "next-version.py"
SPEC = importlib.util.spec_from_file_location("next_version", SCRIPT)
NEXT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NEXT)


class NextVersionTests(unittest.TestCase):
    def next(self, today, tags):
        return NEXT.next_version(today, tags)

    def test_counter_starts_at_one_and_follows_the_same_day_tags(self):
        self.assertEqual(self.next("20260920", []), "20260920.1")
        self.assertEqual(self.next("20260920", ["v20260920.1"]), "20260920.2")
        self.assertEqual(self.next("20260920", ["v20260920.9", "v20260920.10"]), "20260920.11")
        self.assertEqual(self.next("20260920", ["refs/tags/v20260920.2", "v20260920.1"]), "20260920.3")
        self.assertEqual(self.next("20260920", ["v20260919.7", "v20250101.4"]), "20260920.1")
        self.assertEqual(self.next("20260920", [" v20260920.1\n"]), "20260920.2")

    def test_unrelated_tags_cannot_influence_publication(self):
        unrelated = ["v1.2.3", "20260920.1", "V20260920.1", "v020260920.1", "v20260920.01",
                     "v20260920.0", "v2026092.1", "v20260920.1-rc.1", "refs/heads/v20260920.1",
                     "vv20260920.1", "", "garbage"]
        self.assertEqual(self.next("20260920", unrelated), "20260920.1")
        self.assertEqual(self.next("20260920", [*unrelated, "v20260920.4"]), "20260920.5")

    def test_rejects_bad_dates_and_future_tags(self):
        for today in ("", "2026092", "202609201", "02260920", "2026-09-20", "20260920.1"):
            with self.subTest(today=today), self.assertRaises(ValueError):
                self.next(today, [])
        with self.assertRaises(ValueError):
            self.next("20260920", ["v20260921.1"])
        with self.assertRaises(ValueError):
            self.next("20260920", [f"v20260920.{2**64 - 1}"])

    def test_command_line_reads_tags_from_stdin(self):
        result = subprocess.run(["python3", str(SCRIPT), "20260920"], input="v20260920.1\nv20260919.3\n",
                                capture_output=True, text=True, timeout=10)
        self.assertEqual((result.returncode, result.stdout), (0, "20260920.2\n"))
        for arguments, stdin in (([], ""), (["20260920", "extra"], ""), (["bad"], ""),
                                 (["20260920"], "v20260921.1\n")):
            with self.subTest(arguments=arguments, stdin=stdin):
                result = subprocess.run(["python3", str(SCRIPT), *arguments], input=stdin,
                                        capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
