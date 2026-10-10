#!/usr/bin/env python3
"""Offline release contract tests; HERDR_TEST_SBOM=1 also runs cargo-cyclonedx."""

import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("manifest", ROOT / "scripts/release/artifact-manifest.py")
MANIFEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MANIFEST)
SPEC = importlib.util.spec_from_file_location("sbom", ROOT / "scripts/release/generate-sbom.py")
SBOM = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SBOM)
VERSION = "20260920.1"


class ReleaseTargets(unittest.TestCase):
    def test_verifier_uses_one_exact_attestation_identity(self):
        verifier = (ROOT / "scripts/verify-release.sh").read_text()
        command = verifier.split('gh attestation verify "$file"', 1)[1].split('\n    if ', 1)[0]
        self.assertIn('--cert-identity "$identity"', command)
        for flag in ("--cert-identity-regex", "--signer-repo", "--signer-workflow"):
            self.assertNotIn(flag, command)
        for flag in ("--source-digest", "--signer-digest"):
            self.assertIn(f'{flag} "$sha"', command)
        self.assertIn('--source-ref refs/heads/main', command)
        self.assertIn('--deny-self-hosted-runners', command)

    def test_ci_platform_checks_keep_owner_policy_and_required_gate(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        sections = re.split(r"^  ([a-z-]+):\n", workflow.split("\njobs:\n", 1)[1], flags=re.M)
        jobs = dict(zip(sections[1::2], sections[2::2]))
        for job in jobs.values():
            for condition in ("github.repository == 'penso/herdr-gpui'",
                              "github.actor == 'penso'", "github.triggering_actor == 'penso'"):
                self.assertIn(condition, job)
        self.assertIn("    needs: [checks, windows, commits]\n", jobs["checks-passed"])
        self.assertIn('test "$COMMITS" = success || exit 1', jobs["checks-passed"])
        self.assertIn('test "$RESULT" = success && test "$WINDOWS" = success', jobs["checks-passed"])
        self.assertIn('test "$CODE" = false && test "$RESULT" = skipped && test "$WINDOWS" = skipped', jobs["checks-passed"])
        for name in ("checks", "windows", "build"):
            self.assertIn("needs.commits.outputs.code == 'true'", jobs[name])
            self.assertIn("needs: [zizmor, commits]", jobs[name])
        self.assertIn("WINDOWS: ${{ needs.windows.result }}", jobs["checks-passed"])
        self.assertIn("          fetch-depth: 0\n", jobs["commits"])
        self.assertIn("python3 scripts/release/check-commit-messages.py range", jobs["commits"])
        for name in ("checks", "windows", "checks-passed"):
            self.assertIn("github.event.pull_request.user.login == 'penso'", jobs[name])
            self.assertIn("github.event.pull_request.head.repo.full_name == 'penso/herdr-gpui'", jobs[name])
        self.assertIn("runner: [macos-14, macos-15, ubuntu-24.04, ubuntu-24.04-arm]", jobs["checks"])
        self.assertIn("    name: Format, lint, and test\n", jobs["checks-passed"])
        self.assertIn("always()", jobs["checks-passed"])
        self.assertIn('test "$RESULT" = success', jobs["checks-passed"])
        self.assertIn("github.ref == 'refs/heads/main'", jobs["build"])
        self.assertNotIn("github.event_name == 'pull_request'", jobs["build"])
        for name in ("checks", "build"):
            self.assertIn("bash scripts/install-linux-deps.sh", jobs[name])
        self.assertIn('HERDR_TEST_NFPM=$(bash scripts/release/install-nfpm.sh "$RUNNER_TEMP/nfpm")', jobs["checks"])
        windows = jobs["windows"]
        self.assertIn("        runner: [windows-2025, windows-11-arm]\n", windows)
        self.assertIn("    runs-on: ${{ matrix.runner }}\n", windows)
        for name in ("checks", "windows"):
            for command in ("cargo fmt --all -- --check",
                            "cargo clippy --locked --workspace --all-targets --all-features -- -D warnings",
                            "cargo test --locked --workspace",
                            "cargo test --locked --workspace --all-features"):
                self.assertIn(f"run: {command}\n", jobs[name])
        self.assertNotIn("--release", windows)
        self.assertNotIn("cargo build", windows)

    def test_workflow_and_metadata_contract(self):
        # Keep this offline and dependency-free; actionlint validates YAML syntax.
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        sections = re.split(r"^  ([a-z-]+):\n", workflow.split("\njobs:\n", 1)[1], flags=re.M)
        jobs = dict(zip(sections[1::2], sections[2::2]))
        targets = {"aarch64-apple-darwin", "x86_64-apple-darwin",
                   "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
                   "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"}
        self.assertEqual(set(SBOM.TARGETS), targets)
        self.assertEqual(set(tomllib.loads((ROOT / "deny.toml").read_text())["graph"]["targets"]), targets)
        self.assertEqual(set(tomllib.loads((ROOT / "scripts/release/about.toml").read_text())["targets"]), targets)
        self.assertEqual(set(re.findall(r"^            target: (\S+)$", workflow, re.M)), targets)
        linux = jobs["linux"]
        self.assertEqual(re.findall(r"- runner: (\S+)\n            target: (\S+)", linux), [
            ("ubuntu-24.04", "x86_64-unknown-linux-gnu"),
            ("ubuntu-24.04-arm", "aarch64-unknown-linux-gnu")])
        for command in ('cargo build --locked --release -p herdr-gpui --target "$TARGET"',
                        'cargo test --locked --release -p herdr-gpui --test cli --target "$TARGET"',
                        'cargo clippy --locked --workspace --all-targets --all-features -- -D warnings',
                        'cargo test --locked --workspace --all-features',
                        'test "$(rustc -vV | sed -n \'s/^host: //p\')" = "$TARGET"',
                        'name: linux-package-${{ matrix.target }}',
                        'bash scripts/release/package-linux.sh "$VERSION" "$TARGET"',
                        'bash scripts/release/install-nfpm.sh "$RUNNER_TEMP/nfpm"',
                        'python3 scripts/release/package-linux-distro.py "$VERSION" "$TARGET"',
                        'bash scripts/release/smoke-linux-packages.sh "$VERSION" "$TARGET" dist'):
            self.assertIn(command, linux)
        for extension in ("tar.gz", "deb", "rpm", "pkg.tar.zst"):
            self.assertIn(f"dist/Herdr-${{{{ needs.validate.outputs.version }}}}-${{{{ matrix.target }}}}.{extension}\n", linux)
        for target in ("x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"):
            self.assertIn(f"name: linux-package-{target}\n", jobs["attest"])
        windows = jobs["windows"]
        self.assertEqual(re.findall(r"- runner: (\S+)\n            target: (\S+)", windows), [
            ("windows-2025", "x86_64-pc-windows-msvc"),
            ("windows-11-arm", "aarch64-pc-windows-msvc")])
        for command in ('cargo build --locked --release -p herdr-gpui --target "$TARGET"',
                        'cargo test --locked --release -p herdr-gpui --test cli --target "$TARGET"',
                        'cargo clippy --locked --workspace --all-targets --all-features -- -D warnings',
                        'cargo test --locked -p herdr-protocol -p herdr-client',
                        'test "$(rustc -vV | sed -n \'s/^host: //p\')" = "$TARGET"',
                        'python scripts/release/generate-notices.py',
                        'python scripts/release/package-windows.py "$VERSION" "$TARGET"',
                        'name: windows-package-${{ matrix.target }}'):
            self.assertIn(command, windows)
        for target in ("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"):
            self.assertIn(f"name: windows-package-{target}\n", jobs["attest"])
        for name in ("sign", "attest"):
            self.assertRegex(jobs[name], r"    needs: \[[^]]*\bwindows\b")
        attest = jobs["attest"].replace("${{ needs.validate.outputs.version }}", VERSION)
        signed = re.search(r"^          files: (.+)$", attest, re.M)[1].split()
        subjects = re.findall(r"^            dist/(\S+)$", attest, re.M)
        self.assertEqual(sorted(signed), sorted(MANIFEST.base_names(VERSION)))
        self.assertEqual(sorted(subjects), sorted(MANIFEST.base_names(VERSION)))
        for script in ("verify-release.sh", "gpg-sign-release.sh"):
            text = (ROOT / "scripts" / script).read_text()
            self.assertIn("while IFS= read -r name; do", text)
            directory = "$directory" if script == "verify-release.sh" else "$output"
            self.assertIn(
                f'done < <(python3 "$scripts/release/artifact-manifest.py" base-names "$version" "{directory}")',
                text,
            )
        self.assertEqual(workflow.count('artifact-manifest.py create "$VERSION" dist'), 1)
        self.assertNotIn("scripts/package-linux.sh", workflow)
        self.assertNotIn("uses: actions/cache", workflow)
        for name in ("macos-checks", "macos-build", "linux", "windows", "metadata", "changelog"):
            self.assertIn("    needs: validate\n", jobs[name])
            self.assertNotIn("secrets.", jobs[name])
            self.assertNotIn("environment:", jobs[name])
        for name, job in jobs.items():
            ref = "github.sha" if name in ("audit", "validate") else "needs.validate.outputs.sha"
            self.assertIn("ref: ${{ " + ref + " }}", job)
            self.assertIn("persist-credentials: false", job)
        for name in ("audit", "validate", "sign", "attest", "publish", "homebrew"):
            for condition in ("github.repository == 'penso/herdr-gpui'", "github.ref == 'refs/heads/main'",
                              "github.actor == 'penso'", "github.triggering_actor == 'penso'"):
                self.assertIn(condition, jobs[name])
        for name in ("sign", "attest", "publish"):
            self.assertIn("    environment: release\n", jobs[name])
        self.assertIn("    environment: homebrew\n", jobs["homebrew"])
        self.assertEqual(re.findall(r"^  (\w+):", workflow.split("permissions:", 1)[0], re.M),
                         ["workflow_dispatch"])

    def test_release_notes_come_from_history_and_stay_out_of_the_signed_assets(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        sections = re.split(r"^  ([a-z-]+):\n", workflow.split("\njobs:\n", 1)[1], flags=re.M)
        jobs = dict(zip(sections[1::2], sections[2::2]))
        changelog = jobs["changelog"]
        # Notes are derived from git history, so the clone must carry all of it.
        self.assertIn("          fetch-depth: 0\n", changelog)
        self.assertIn('bash scripts/release/generate-changelog.sh "$VERSION" release-notes', changelog)
        self.assertIn("          name: release-notes\n", changelog)
        publish = jobs["publish"]
        self.assertIn("    needs: [validate, attest, changelog]\n", publish)
        self.assertIn("          name: release-notes\n", publish)
        self.assertIn("          path: release-notes\n", publish)
        self.assertIn("--notes-file release-notes/RELEASE_NOTES.md", publish)
        # The body is not an asset: it never lands in the checksummed directory.
        self.assertNotIn("release-notes/CHANGELOG.md dist", publish)
        self.assertNotIn("RELEASE_NOTES", str(MANIFEST.asset_names(VERSION)))

    def test_updater_signing_boundary(self):
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        sections = re.split(r"^  ([a-z-]+):\n", workflow.split("\njobs:\n", 1)[1], flags=re.M)
        jobs = dict(zip(sections[1::2], sections[2::2]))
        self.assertIn("scripts/update-manifest.py validate-public-key", jobs["validate"])
        # The publishable version is derived from GitHub's own tags, never dispatched.
        self.assertNotIn("inputs.VERSION", workflow)
        self.assertIn('python3 scripts/release/next-version.py "$(date -u +%Y%m%d)"', jobs["validate"])
        self.assertIn('[[ "$version" =~ ^[1-9][0-9]{7}\\.[1-9][0-9]*$ ]]', jobs["validate"])
        for name in ("macos-build", "linux"):
            self.assertIn("HERDR_RELEASE_VERSION: ${{ needs.validate.outputs.version }}", jobs[name])
            self.assertIn("HERDR_UPDATE_PUBLIC_KEY: ${{ vars.HERDR_UPDATE_PUBLIC_KEY }}", jobs[name])
        for name, job in jobs.items():
            if name != "sign":
                self.assertNotIn("secrets.HERDR_UPDATE_SIGNING_KEY", job)
        sign = jobs["sign"]
        self.assertEqual(sign.count("secrets.HERDR_UPDATE_SIGNING_KEY"), 1)
        self.assertIn('create dist "$VERSION" --require-all-targets', sign)
        self.assertIn("unset HERDR_UPDATE_SIGNING_KEY", sign)
        for target in ("x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"):
            self.assertIn(f"name: linux-package-{target}\n", sign)
        for name in ("update-manifest.json", "update-manifest.sig"):
            self.assertIn(f"            dist/{name}\n", sign)
        self.assertIn('test "$(wc -c < dist/update-manifest.sig | tr -d \' \')" = 64', sign)


class SbomMerge(unittest.TestCase):
    def generate(self, components):
        documents = [{
            "bomFormat": "CycloneDX", "specVersion": "1.5",
            "metadata": {"component": {"bom-ref": "herdr", "name": "herdr-gpui"}},
            "components": [component],
            "dependencies": [{"ref": "herdr", "dependsOn": ["libloading"]},
                             {"ref": "libloading", "dependsOn": []}],
        } for component in components]
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "union.json"
            with mock.patch.object(SBOM.sys, "argv", ["generate-sbom.py", str(output)]), \
                    mock.patch.object(SBOM.shutil, "which", side_effect=lambda name: f"/mock/{name}"), \
                    mock.patch.object(SBOM.subprocess, "run") as run, \
                    mock.patch.object(Path, "read_text", side_effect=[json.dumps(d) for d in documents]):
                SBOM.main()
            self.assertEqual([call.args[0][call.args[0].index("--target") + 1]
                              for call in run.call_args_list], list(SBOM.TARGETS))
            return json.loads(output.read_text())

    def test_platform_scope_union(self):
        # Includes excluded macOS build-time / required Linux runtime, every
        # ordering, optional precedence, and the absent-scope required default.
        for scopes in itertools.product(("excluded", "optional", "required", None), repeat=len(SBOM.TARGETS)):
            with self.subTest(scopes=scopes):
                components = [{"bom-ref": "libloading", "name": "libloading", "version": "0.8.9",
                               **({"scope": scope} if scope is not None else {})} for scope in scopes]
                bom = self.generate(components)
                expected = ("required" if "required" in scopes or None in scopes else
                            "optional" if "optional" in scopes else "excluded")
                self.assertEqual(bom["components"], [dict(components[0], scope=expected)])
                self.assertEqual(bom["dependencies"], [
                    {"ref": "herdr", "dependsOn": ["libloading"]},
                    {"ref": "libloading", "dependsOn": []}])
                self.assertEqual(bom["metadata"]["properties"], [
                    {"name": "herdr:release:targets", "value": ",".join(SBOM.TARGETS)}])

    def test_non_scope_conflicts_rejected(self):
        component = {"bom-ref": "libloading", "name": "libloading", "version": "0.8.9",
                     "purl": "pkg:cargo/libloading@0.8.9", "scope": "excluded",
                     "hashes": [{"alg": "SHA-256", "content": "a" * 64}],
                     "licenses": [{"license": {"id": "MIT"}}]}
        for field, value in (
            ("name", "different"), ("version", "0.8.8"), ("purl", "pkg:cargo/other@0.8.9"),
            ("hashes", [{"alg": "SHA-256", "content": "b" * 64}]),
            ("licenses", [{"license": {"id": "Apache-2.0"}}]),
        ):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "Conflicting SBOM component"):
                self.generate([component] * (len(SBOM.TARGETS) - 1) +
                              [dict(component, scope="required", **{field: value})])

    def test_invalid_scope_rejected(self):
        for scope in (None, "unknown"):
            with self.subTest(scope=scope), self.assertRaisesRegex(ValueError, "Invalid SBOM component scope"):
                self.generate([{"bom-ref": "libloading", "name": "libloading", "scope": scope}] * len(SBOM.TARGETS))


class ReleaseSecurity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        for name in MANIFEST.base_names(VERSION):
            data = b"s" * 64 if name == "update-manifest.sig" else name.encode()
            (self.path / name).write_bytes(data)
            for algorithm in ("sha256", "sha512"):
                checksum = hashlib.new(algorithm, data).hexdigest()
                (self.path / f"{name}.{algorithm}").write_text(f"{checksum}  {name}\n")
            for suffix in ("sig", "crt"):
                (self.path / f"{name}.{suffix}").write_text("test fixture, not a signature\n")
        self.run_manifest("create")

    def run_manifest(self, mode, success=True, directory=None):
        result = subprocess.run(["python3", str(ROOT / "scripts/release/artifact-manifest.py"),
                                 mode, VERSION, str(directory or self.path)], capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stderr.decode())
        return result.stdout.decode()

    def test_complete_set_and_homebrew(self):
        self.run_manifest("verify")
        self.assertEqual(set(MANIFEST.base_names(VERSION)), {
            "Herdr-20260920.1-universal-apple-darwin.dmg", "Herdr-20260920.1.cdx.json",
            *(f"Herdr-20260920.1-{target}.{extension}"
              for target in ("x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu")
              for extension in ("tar.gz", "deb", "rpm", "pkg.tar.zst")),
            "Herdr-20260920.1-x86_64-pc-windows-msvc.zip",
            "Herdr-20260920.1-aarch64-pc-windows-msvc.zip",
            "herdr-gpui-20260920.1-macos-universal.app.tar.gz",
            "herdr-gpui-20260920.1-x86_64-unknown-linux-gnu-update.tar.gz",
            "herdr-gpui-20260920.1-aarch64-unknown-linux-gnu-update.tar.gz",
            "update-manifest.json", "update-manifest.sig"})
        self.assertEqual(len((self.path / "SHA256SUMS").read_text().splitlines()), 85)
        self.assertEqual(len(self.run_manifest("names").splitlines()), 86)
        self.assertEqual(self.run_manifest("base-names").splitlines(), MANIFEST.base_names(VERSION))
        with tempfile.TemporaryDirectory() as temp:
            name = MANIFEST.base_names(VERSION)[0]
            for file in (name, "SHA256SUMS"):
                shutil.copyfile(self.path / file, Path(temp) / file)
            self.assertEqual(self.run_manifest("dmg", directory=temp).strip(),
                             hashlib.sha256(name.encode()).hexdigest())

    def test_missing_base_or_sidecar(self):
        for name in MANIFEST.asset_names(VERSION):
            with self.subTest(name=name):
                path = self.path / name
                data = path.read_bytes()
                path.unlink()
                self.run_manifest("verify", False)
                path.write_bytes(data)

    def test_extra_asset(self):
        (self.path / "unexpected").write_text("extra")
        self.run_manifest("verify", False)

    def test_raw_updater_signature_length(self):
        path = self.path / "update-manifest.sig"
        for size in (1, 63, 65, 128):
            path.write_bytes(b"s" * size)
            with self.subTest(size=size), self.assertRaisesRegex(ValueError, "raw 64-byte"):
                MANIFEST.check_files(self.path, MANIFEST.asset_names(VERSION) + ["SHA256SUMS"])

    def test_corrupt_sidecar(self):
        (self.path / (MANIFEST.base_names(VERSION)[0] + ".sha512")).write_text("invalid")
        self.run_manifest("verify", False)

    def test_duplicate_manifest_entry(self):
        path = self.path / "SHA256SUMS"
        path.write_text(path.read_text() + path.read_text().splitlines()[0] + "\n")
        self.run_manifest("verify", False)

    def test_symlink(self):
        path = self.path / (MANIFEST.base_names(VERSION)[0] + ".sig")
        path.unlink()
        path.symlink_to(self.path / "SHA256SUMS")
        self.run_manifest("verify", False)

    def test_invalid_versions_and_missing_arguments(self):
        for script in ("verify-release.sh", "gpg-sign-release.sh"):
            for args in (["--version"], ["--version", "20260920.01"], ["--version", "v020260920.1"]):
                result = subprocess.run(["bash", str(ROOT / "scripts" / script), *args],
                                        capture_output=True)
                self.assertNotEqual(result.returncode, 0)

    def test_sign_action_rejects_partial_glob_before_signing(self):
        # The action has a single final run block; no YAML dependency needed.
        text = (ROOT / ".github/actions/sign-artifacts/action.yml").read_text()
        code = "\n".join(line[8:] for line in text.split("      run: |\n", 1)[1].splitlines())
        result = subprocess.run(["bash", "-c", code], cwd=self.path,
                                env=dict(os.environ, FILES_PATTERN="*.dmg *.missing"),
                                capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"missing, empty, or symlink", result.stdout)
        self.assertNotIn(b"Signing:", result.stdout)

    def test_sign_action_preserves_raw_updater_signature(self):
        raw = (self.path / "update-manifest.sig").read_bytes()
        for path in self.path.iterdir():
            if path.name not in MANIFEST.base_names(VERSION):
                path.unlink()
        self.run_manifest("base")
        text = (ROOT / ".github/actions/sign-artifacts/action.yml").read_text()
        code = "\n".join(line[8:] for line in text.split("      run: |\n", 1)[1].splitlines())
        with tempfile.TemporaryDirectory() as temp:
            tool = Path(temp) / "cosign"
            tool.write_text('''#!/usr/bin/env bash
set -eu
[[ $1 == sign-blob && $2 == --yes && $3 == --output-signature && $5 == --output-certificate ]]
[[ $4 == "$7.sig" && $6 == "$7.crt" && -s $7 ]]
printf 'mock Sigstore signature\\n' > "$4"
printf 'mock Sigstore certificate\\n' > "$6"
''')
            tool.chmod(0o755)
            subprocess.run(["bash", "-c", code], cwd=self.path, check=True, capture_output=True,
                           env=dict(os.environ, PATH=f"{temp}:{os.environ['PATH']}",
                                    FILES_PATTERN=" ".join(MANIFEST.base_names(VERSION))))
        self.assertEqual((self.path / "update-manifest.sig").read_bytes(), raw)
        for name in ("update-manifest.json.sig", "update-manifest.sig.sig"):
            self.assertEqual((self.path / name).read_text(), "mock Sigstore signature\n")
        self.run_manifest("create")
        self.run_manifest("verify")

    def test_verifier_trust_policy_and_failures(self):
        with tempfile.TemporaryDirectory() as temp:
            tools = Path(temp)
            (tools / "gh").write_text('''#!/usr/bin/env bash
set -eu
if [[ $1 == api ]]; then
    printf '%040d\\n' 1
elif [[ $1 == attestation && $2 == verify ]]; then
    printf '%s\\n' "${3##*/}" >> "$ATTEST_LOG"
    [[ "$*" == *"--source-ref refs/heads/main"* ]]
    [[ "$*" == *"--source-digest 0000000000000000000000000000000000000001"* ]]
    [[ "$*" == *"--signer-digest 0000000000000000000000000000000000000001"* ]]
    [[ "$*" == *"--cert-identity https://github.com/penso/herdr-gpui/.github/workflows/release.yml@refs/heads/main"* ]]
    if [[ ${FAIL_ARM_ATTEST:-0} == 1 && $3 == *aarch64-unknown-linux-gnu.tar.gz ]]; then exit 1; fi
    exit "${FAIL_ATTEST:-0}"
else
    exit 99
fi
''')
            (tools / "cosign").write_text('''#!/usr/bin/env bash
set -eu
[[ $1 == verify-blob ]]
printf '%s\\n' "${!#}" >> "$COSIGN_LOG"
[[ "$*" == *"--certificate-identity https://github.com/penso/herdr-gpui/.github/workflows/release.yml@refs/heads/main"* ]]
[[ "$*" == *"--certificate-oidc-issuer https://token.actions.githubusercontent.com"* ]]
[[ "$*" == *"--certificate-github-workflow-sha 0000000000000000000000000000000000000001"* ]]
if [[ ${FAIL_ARM_COSIGN:-0} == 1 && ${!#} == *aarch64-unknown-linux-gnu.tar.gz ]]; then exit 1; fi
exit "${FAIL_COSIGN:-0}"
''')
            (tools / "gpg").write_text('''#!/usr/bin/env bash
set -eu
[[ $1 == --homedir && -d $2 && $2 == */keyring ]]
if [[ "$*" == *"--verify"* ]]; then
    printf '%s\\n' "${!#}" >> "$GPG_LOG"
    if [[ ${FAIL_ARM_GPG:-0} == 1 && ${!#} == *aarch64-unknown-linux-gnu.tar.gz ]]; then exit 1; fi
    printf '[GNUPG:] VALIDSIG %s 2026-09-20 0 0 4 0 1 10 00 %040d\\n' "$TEST_SIGNER" 2
fi
''')
            for tool in tools.iterdir():
                tool.chmod(0o755)
            env = dict(os.environ, PATH=f"{tools}:{os.environ['PATH']}",
                       ATTEST_LOG=str(tools / "attest.log"), COSIGN_LOG=str(tools / "cosign.log"),
                       GPG_LOG=str(tools / "gpg.log"))
            command = ["bash", str(ROOT / "scripts/verify-release.sh"),
                       "--version", "v20260920.1", "--directory", str(self.path)]
            for extra, updates, success in (
                ([], {}, True),
                (["--sha", "2" * 40], {}, False),
                ([], {"FAIL_COSIGN": "1"}, False),
                ([], {"FAIL_ATTEST": "1"}, False),
                ([], {"FAIL_ARM_COSIGN": "1"}, False),
                ([], {"FAIL_ARM_ATTEST": "1"}, False),
            ):
                result = subprocess.run(command + extra, env=dict(env, **updates), capture_output=True)
                self.assertEqual(result.returncode == 0, success, result.stderr.decode())
                if success:
                    for log in ("cosign.log", "attest.log"):
                        self.assertEqual([Path(line).name for line in (tools / log).read_text().splitlines()],
                                         MANIFEST.base_names(VERSION))
            key = tools / "public.asc"
            key.write_text("mock public key")
            command += ["--gpg-key", str(key), "--gpg-fingerprint", "1" * 40]
            for signer, fail_arm, success in (("1" * 40, "0", True), ("2" * 40, "0", False),
                                             ("1" * 40, "1", False)):
                result = subprocess.run(command, env=dict(env, TEST_SIGNER=signer, FAIL_ARM_GPG=fail_arm),
                                        capture_output=True)
                self.assertEqual(result.returncode == 0, success, result.stderr.decode())
                if success:
                    self.assertEqual([Path(line).name for line in (tools / "gpg.log").read_text().splitlines()],
                                     MANIFEST.base_names(VERSION))

    @unittest.skipUnless(os.environ.get("HERDR_TEST_SBOM") == "1", "opt-in real metadata generation")
    def test_real_sbom(self):
        # Isolate generator outputs from the collaborative worktree.
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp)
            for name in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml"):
                shutil.copyfile(ROOT / name, workspace / name)
            shutil.copytree(ROOT / "crates", workspace / "crates",
                            ignore=shutil.ignore_patterns("target", "sbom.json"))
            shutil.copytree(ROOT / "scripts/release", workspace / "scripts/release")
            (workspace / "scripts/release/cargo-locked.sh").chmod(0o755)
            before = (workspace / "Cargo.lock").read_bytes()
            subprocess.run(["python3", "scripts/release/generate-sbom.py", "release.cdx.json"],
                           cwd=workspace, check=True)
            self.assertEqual(before, (workspace / "Cargo.lock").read_bytes())
            bom = json.loads((workspace / "release.cdx.json").read_text())
            names = {component["name"] for component in bom["components"]}
            self.assertTrue({"gpui", "metal", "wayland-client", "cc"} <= names)
            self.assertEqual(bom["metadata"]["properties"], [
                {"name": "herdr:release:targets", "value": ",".join(SBOM.TARGETS)}])
            manifest = workspace / "Cargo.toml"
            text = manifest.read_text()
            version = tomllib.loads(text)["workspace"]["package"]["version"]
            manifest.write_text(text.replace(f'version = "{version}"', 'version = "999.0.0"', 1))
            result = subprocess.run(["python3", "scripts/release/generate-sbom.py", "invalid.cdx.json"],
                                    cwd=workspace, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"--locked", result.stderr)
            self.assertEqual(before, (workspace / "Cargo.lock").read_bytes())


if __name__ == "__main__":
    unittest.main()
