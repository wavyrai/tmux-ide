#!/usr/bin/env python3
"""Test the real updater without compiling GPUI (Python 3.11+, Rust via rustup).

The temporary package inherits workspace dependency options and exact direct
versions from Cargo.lock. Cargo metadata prunes a COPY of that lock, then every
resolved package/checksum is checked against the original before testing with
--locked. No repository lock or source is modified. Use --offline to prohibit
Cargo downloads; otherwise only normal Cargo dependency downloads are needed.
The repository toolchain must already be installed (CI runs rustup show first).

Linux additionally exercises the real helper with offline, deterministically
signed fixtures in a private HOME. Run as a non-root user for those tests.
No daemon, desktop, network update endpoint, or production signing key is used.
All generated source, binaries, lockfiles and fixture homes are temporary; this
script does not publish artifacts. Rust source paths are remapped in binaries.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib


DEPENDENCIES = (
    "anyhow",
    "serde", "serde_json", "ureq", "ed25519-dalek", "sha2", "tempfile", "tar", "flate2", "thiserror",
)
# Public half of the deliberately public [42; 32] unit-test signing seed.
PUBLIC_KEY = "197f6b23e16c8532c6abc838facd5ea789be0c76b2920334039bfa8b3d368d61"
VERSION = "20260920.1"

MAIN = r'''
const APP_VERSION: &str = env!("HERDR_RELEASE_VERSION");
pub use updater::UpdateError;

fn main() -> Result<std::process::ExitCode, Box<dyn std::error::Error>> {
    use anyhow::Context as _;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let Some(code) = updater::run_helper(&args) {
        return Ok(code);
    }
    match args.first().and_then(|arg| arg.to_str()) {
        Some("--harness-sign") if args.len() == 1 => {
            use ed25519_dalek::{Signer, SigningKey};
            use std::io::Read;
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).context("read signing input")?;
            let key = SigningKey::from_bytes(&[42; 32]);
            println!("{}", serde_json::to_string(&key.sign(&bytes).to_bytes().to_vec())?);
        }
        Some("--harness-restarted") if args.len() == 3 => {
            use std::os::unix::ffi::OsStrExt;
            let report = serde_json::json!({
                "argument": args[2].as_bytes(),
                "cwd": std::env::current_dir().context("read restart working directory")?.as_os_str().as_bytes(),
            });
            std::fs::write(&args[1], serde_json::to_vec(&report)?).context("write restart report")?;
        }
        _ => return Ok(std::process::ExitCode::FAILURE),
    }
    Ok(std::process::ExitCode::SUCCESS)
}

#[test]
fn embedded_fixture_key_and_version_match() {
    let public: String = ed25519_dalek::SigningKey::from_bytes(&[42; 32])
        .verifying_key().as_bytes().iter().map(|byte| format!("{byte:02x}")).collect();
    assert_eq!(public, env!("HERDR_UPDATE_PUBLIC_KEY"));
    assert_eq!(APP_VERSION, "20260920.1");
}
'''


def toml_value(value):
    """The workspace/lock subset needs only TOML scalars, arrays and inline tables."""
    if isinstance(value, dict):
        return "{ " + ", ".join(
            f"{json.dumps(key)} = {toml_value(item)}" for key, item in value.items()
        ) + " }"
    if isinstance(value, list):
        return "[" + ", ".join(map(toml_value, value)) + "]"
    return json.dumps(value, ensure_ascii=False)


def package_identity(package):
    return tuple(package.get(key) for key in ("name", "version", "source", "checksum"))


def generate(root, temporary):
    workspace = tomllib.loads((root / "Cargo.toml").read_text())["workspace"]
    member = tomllib.loads((root / "crates/herdr-gpui/Cargo.toml").read_text())
    lock = tomllib.loads((root / "Cargo.lock").read_text())
    package = dict(workspace["package"], name=member["package"]["name"])
    locked_root, = [item for item in lock["package"] if item["name"] == package["name"]]
    dependencies = {}
    references = []
    for name in DEPENDENCIES:
        inherited = member["dependencies"][name]
        if not inherited.get("workspace"):
            raise ValueError(f"{name} must inherit its workspace dependency")
        definition = workspace["dependencies"][name]
        definition = {"version": definition} if isinstance(definition, str) else dict(definition)
        reference, = [ref for ref in locked_root["dependencies"] if ref.split()[0] == name]
        parts = reference.split()
        locked, = [item for item in lock["package"] if item["name"] == name
                   and (len(parts) == 1 or item["version"] == parts[1])]
        if not locked.get("source", "").startswith("registry+"):
            raise ValueError(f"Expected registry dependency: {name}")
        definition["version"] = "=" + locked["version"]
        for key, value in inherited.items():
            if key == "features":
                definition[key] = sorted(set(definition.get(key, []) + value))
            elif key != "workspace":
                definition[key] = value
        dependencies[name] = definition
        references.append(reference)

    manifest = "[workspace]\nresolver = " + toml_value(workspace["resolver"]) + "\n"
    for section, values in [("package", package), ("dependencies", dependencies)]:
        manifest += f"\n[{section}]\n"
        manifest += "".join(f"{json.dumps(key)} = {toml_value(value)}\n"
                            for key, value in values.items())
    (temporary / "Cargo.toml").write_text(manifest)
    original_identities = {package_identity(item) for item in lock["package"]}
    locked_root["dependencies"] = references
    projected = f"version = {lock['version']}\n"
    for item in lock["package"]:
        projected += "\n[[package]]\n"
        projected += "".join(f"{key} = {toml_value(value)}\n" for key, value in item.items())
    (temporary / "Cargo.lock").write_text(projected)
    shutil.copyfile(root / "rust-toolchain.toml", temporary / "rust-toolchain.toml")
    (temporary / "src").mkdir()
    source = root / "crates/herdr-gpui/src/updater.rs"
    # An absolute #[path] to updater.rs searches its children beside that file,
    # not in updater/. A symlinked mod.rs preserves Rust's submodule lookup while
    # compiling the original files, without copying or rewriting their contents.
    modules = temporary / "src/updater"
    modules.mkdir()
    (modules / "mod.rs").symlink_to(source)
    # Include updater/error.rs directly with its siblings; the updater owns its
    # Result alias and does not need the GPUI/config-dependent crate error module.
    for child in source.with_suffix("").iterdir():
        (modules / child.name).symlink_to(child, target_is_directory=child.is_dir())
    # The updater names the app's identifiers through constants.rs, which holds
    # only plain constants and so compiles here unchanged.
    constants = root / "crates/herdr-gpui/src/constants.rs"
    # Unused UI entry points are expected in this updater-only binary.
    # The updater reads build identities such as the app ID from constants.rs,
    # plain values with no GPUI dependency, compiled here as the app does.
    constants = root / "crates/herdr-gpui/src/constants.rs"
    (temporary / "src/main.rs").write_text(
        f"#[allow(dead_code)]\n#[path = {json.dumps(str(modules / 'mod.rs'), ensure_ascii=False)}]\n"
        "mod updater;\n"
        f"#[allow(dead_code)]\n#[path = {json.dumps(str(constants), ensure_ascii=False)}]\n"
        "mod constants;\n" + MAIN
    )
    return original_identities, package["name"]


def linux_helper_tests(binary, parent):
    target = {"x86_64": "x86_64", "aarch64": "aarch64"}[os.uname().machine]
    target += "-unknown-linux-gnu"
    old = binary.read_bytes()
    # ELF permits trailing bytes: the replacement remains our native fixture
    # executable, but byte comparison distinguishes it from the old installation.
    new = old + b"updater-test-replacement\n"
    for case in ("commit", "cancel", "wrong-token", "bad-signature", "bad-archive",
                 "stale-version", "unsafe-stage", "symlink-stage", "spawn-failure"):
        with tempfile.TemporaryDirectory(prefix="helper-", dir=parent) as directory:
            home = Path(directory).resolve()
            executable = home / "herdr-gpui"
            executable.write_bytes(old)
            executable.chmod(0o700)
            stage = Path(tempfile.mkdtemp(prefix=".herdr-update-", dir=home))
            marker = home / "restarted.json"
            environment = {"HOME": str(home), "PATH": "/usr/bin:/bin", "LC_ALL": "C"}
            payload_name = f"herdr-gpui-20260920.2-{target}"
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                entry = tarfile.TarInfo(payload_name)
                entry.mode = 0o700
                entry.size = len(new)
                archive.addfile(entry, io.BytesIO(new))
            archive_bytes = gzip.compress(buffer.getvalue(), mtime=0)
            (stage / "archive.tar.gz").write_bytes(archive_bytes)
            manifest = json.dumps({"schema": 1, "version": "20260920.2", "assets": [{
                "target": target, "name": payload_name + "-update.tar.gz",
                "size": len(archive_bytes), "sha256": hashlib.sha256(archive_bytes).hexdigest(),
            }]}).encode()
            signature = json.loads(subprocess.run(
                [executable, "--harness-sign"], input=manifest, capture_output=True,
                env=environment, cwd=home, check=True, timeout=10,
            ).stdout)
            argument = b"space and non-UTF8: \xff"
            request = {
                "current_version": VERSION, "version": "20260920.2",
                "manifest": list(manifest), "signature": signature,
                "args": [list(b"--harness-restarted"), list(os.fsencode(marker)), list(argument)],
                "cwd": list(os.fsencode(home)), "token": [42] * 32,
            }
            if case == "bad-signature":
                request["signature"][0] ^= 1
            elif case == "bad-archive":
                (stage / "archive.tar.gz").write_bytes(b"not the signed archive")
            elif case == "stale-version":
                request["current_version"] = "20260919.1"
            elif case == "unsafe-stage":
                stage.chmod(0o755)
            elif case == "spawn-failure":
                request["cwd"] = list(os.fsencode(home / "missing"))
            (stage / "request.json").write_text(json.dumps(request))
            (stage / "request.json").chmod(0o600)
            stage_arg = stage
            if case == "symlink-stage":
                stage_arg = home / ".herdr-update-link"
                stage_arg.symlink_to(stage, target_is_directory=True)
            rejected = case in {"bad-signature", "bad-archive", "stale-version",
                                "unsafe-stage", "symlink-stage"}
            with subprocess.Popen(
                [executable, "--herdr-apply-update", stage_arg], env=environment, cwd=home,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            ) as helper:
                try:
                    if not rejected:
                        with selectors.DefaultSelector() as selector:
                            selector.register(helper.stdout, selectors.EVENT_READ)
                            assert selector.select(15), f"{case}: helper READY timed out"
                        assert os.read(helper.stdout.fileno(), 6) == b"READY\n", case
                        assert executable.read_bytes() == old, case
                        assert not marker.exists(), case
                    instruction = b"COMMIT\n" + bytes([43 if case == "wrong-token" else 42]) * 32
                    if case == "cancel" or rejected:
                        instruction = b""
                    stdout, stderr = helper.communicate(instruction, timeout=15)
                except BaseException:
                    helper.kill()
                    helper.communicate()
                    raise
            success = case == "commit"
            assert (helper.returncode == 0) == success, (case, helper.returncode, stderr)
            assert not stdout, (case, stdout)
            assert executable.read_bytes() == (new if success else old), case
            backup = stage / "previous-installation"
            if success:
                assert backup.read_bytes() == old
                deadline = time.monotonic() + 5
                # Atomicity is not assumed for the fixture's tiny report write.
                while True:
                    try:
                        report = json.loads(marker.read_bytes())
                        break
                    except (FileNotFoundError, json.JSONDecodeError):
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(0.01)
                assert report == {"argument": list(argument), "cwd": list(os.fsencode(home))}
                assert "Update installed" in (stage / "install-result.txt").read_text()
            else:
                assert not marker.exists(), case
                assert not backup.exists(), case
                if case == "spawn-failure":
                    assert "restart failed" in (stage / "install-result.txt").read_text()
            print(f"Linux helper: {case} passed", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Use only cached Cargo dependencies")
    args = parser.parse_args()
    if not __debug__:
        parser.error("Python optimization disables test assertions; run without -O/PYTHONOPTIMIZE")
    if sys.platform == "linux" and os.geteuid() == 0:
        parser.error("Linux helper tests require a non-root user; do not run with sudo")
    root = Path(__file__).resolve().parents[1]
    channel = tomllib.loads((root / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
    with tempfile.TemporaryDirectory(prefix="herdr-updater-tests-") as directory:
        temporary = Path(directory).resolve()
        identities, name = generate(root, temporary)
        environment = dict(os.environ)
        environment.pop("RUSTFLAGS", None)
        environment.update({
            "HERDR_RELEASE_VERSION": VERSION, "HERDR_UPDATE_PUBLIC_KEY": PUBLIC_KEY,
            "CARGO_TARGET_DIR": str(temporary / "target"),
            "CARGO_ENCODED_RUSTFLAGS": "\x1f".join([
                f"--remap-path-prefix={root}=/herdr-source",
                f"--remap-path-prefix={temporary}=/updater-harness",
            ]),
        })
        cargo = ["rustup", "run", channel, "cargo"]
        offline = ["--offline"] if args.offline else []

        def run(arguments, **kwargs):
            return subprocess.run(cargo + arguments + offline, cwd=temporary,
                                  env=environment, check=True, **kwargs)

        print(f"Updater-only harness: Rust {channel}, {sys.platform}", flush=True)
        # Reconcile the reduced feature graph in the temporary lock only. Unlike
        # generate-lockfile, metadata retains existing transitive resolutions.
        run(["metadata", "--format-version=1"], stdout=subprocess.DEVNULL)
        resolved = tomllib.loads((temporary / "Cargo.lock").read_text())
        unexpected = {package_identity(item) for item in resolved["package"]} - identities
        if unexpected:
            raise RuntimeError(f"Harness resolution escaped workspace lock: {sorted(unexpected)}")
        assert not any(item["name"] == "gpui" for item in resolved["package"])
        run(["build", "--locked"])
        binary = temporary / "target/debug" / name
        invalid = subprocess.run([binary, "--herdr-apply-update"], timeout=10, check=False)
        assert invalid.returncode == 1, "Malformed helper invocation must fail closed"
        if sys.platform == "linux":
            linux_helper_tests(binary, temporary)
        else:
            print("Linux helper handshake is Linux-only; running shared installer unit tests.", flush=True)
        run(["test", "--locked", "--all-targets"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
