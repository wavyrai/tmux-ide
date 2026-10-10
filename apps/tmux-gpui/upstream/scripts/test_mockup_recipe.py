"""Exercise the mockup recipe with fake build/app executables, without a desktop."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class MockupRecipeTests(unittest.TestCase):
    def test_paths_are_literal_and_relative_to_invocation_directory(self):
        with tempfile.TemporaryDirectory(prefix="mockup-recipe-") as temporary:
            root = Path(temporary).resolve()
            shutil.copyfile(Path(__file__).resolve().parents[1] / "justfile", root / "justfile")
            invocation = root / "work $direction ' `false` $(touch INJECTED)"
            invocation.mkdir()
            bin_dir = root / "bin"
            bin_dir.mkdir()
            app = root / "target/debug/herdr-gpui"
            app.parent.mkdir(parents=True)
            cargo = bin_dir / "cargo"
            cargo.write_text(
                '#!/bin/sh\nprintf "%s\\0" "$HERDR_MOCKUP_FILE" "$@" > "$BUILD_LOG"\n'
            )
            app.write_text('#!/bin/sh\nprintf "%s\\0" "$@" > "$APP_LOG"\n')
            for executable in (cargo, app):
                executable.chmod(0o755)
            build_log = root / "build.log"
            app_log = root / "app.log"
            environment = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "BUILD_LOG": str(build_log),
                "APP_LOG": str(app_log),
            }
            special = "mockup $direction ' \" `false` $(touch INJECTED)"
            for arguments in (
                [],
                [special + ".rs", special + ".md", special + ".png"],
                [str(root / (special + ".rs")), "", str(root / (special + ".png"))],
            ):
                with self.subTest(arguments=arguments):
                    subprocess.run(
                        ["just", "mockup", *arguments],
                        cwd=invocation,
                        env=environment,
                        check=True,
                        capture_output=True,
                        timeout=10,
                    )
                    paths = [
                        str(invocation / path) if path else ""
                        for path in arguments + [""] * (3 - len(arguments))
                    ]
                    self.assertEqual(
                        build_log.read_bytes().split(b"\0")[:-1],
                        [os.fsencode(paths[0]), b"build", b"--locked", b"-p", b"herdr-gpui", b"--features", b"mockup"],
                    )
                    expected = ["--mockup"]
                    for flag, path in zip(("--feedback", "--capture"), paths[1:]):
                        if path:
                            expected.extend((flag, path))
                    self.assertEqual(
                        app_log.read_bytes().split(b"\0")[:-1],
                        [os.fsencode(argument) for argument in expected],
                    )
                    self.assertFalse((root / "INJECTED").exists())
                    self.assertFalse((invocation / "INJECTED").exists())


if __name__ == "__main__":
    unittest.main()
