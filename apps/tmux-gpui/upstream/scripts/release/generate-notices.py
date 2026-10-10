#!/usr/bin/env python3
"""Generate a locked cargo-about license report and preserve source notices."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
ABOUT_VERSION = "cargo-about 0.9.2"
INSTALL = "cargo install cargo-about --version 0.9.2 --locked --features cli"
# cargo-about package exceptions are name-scoped; require a new version review.
MPL_VERSIONS = {
    "cbindgen": "0.28.0", "dwrote": "0.11.5", "nucleo-matcher": "0.3.1",
    "option-ext": "0.2.0",
    "symphonia": "0.5.5", "symphonia-bundle-mp3": "0.5.5",
    "symphonia-core": "0.5.5", "symphonia-metadata": "0.5.5",
}
LICENSE_NAME = re.compile(r"^(licen[cs]e|copying)(?:$|[._-])", re.I)
NOTICE_NAME = re.compile(r"^(notice|copyright)(?:$|[._-])", re.I)
LICENSE_DIRS = {"license", "licenses", "licence", "licences", "legal"}


def collect(package):
    """Supplement cargo-about evidence, not a second license resolver."""
    root = Path(package["manifest_path"]).parent.resolve()
    paths = set()
    explicit = package.get("license_file")
    if explicit:
        paths.add(root / explicit)
    for path in root.iterdir():
        if path.is_file() and (LICENSE_NAME.match(path.name) or NOTICE_NAME.match(path.name)):
            paths.add(path)
        elif path.is_dir() and path.name.lower() in LICENSE_DIRS:
            # Only conventional license directories, never arbitrary vendored trees.
            paths.update(p for p in path.rglob("*") if p.is_file())
    texts = []
    for path in sorted(paths, key=lambda p: p.as_posix()):
        if not path.resolve().is_relative_to(root):
            raise ValueError(f"license path escapes package: {path.name}")
        text = path.read_text(encoding="utf-8")
        if not text.strip():
            raise ValueError(f"empty license/notice: {path.relative_to(root)}")
        relative = path.relative_to(root)
        texts.append((relative.as_posix(), text))
    return texts


def render(evidence, lock_bytes):
    packages = sorted(
        (entry["package"] for entry in evidence["crates"]),
        key=lambda p: (p["name"], p["version"], p.get("source") or ""),
    )
    licenses = evidence["licenses"]
    if not packages or not licenses:
        raise ValueError("cargo-about returned no packages or license texts")
    covered = {use["crate"]["id"] for license in licenses for use in license["used_by"]}
    if covered != {package["id"] for package in packages}:
        raise ValueError("cargo-about license texts do not cover every package")
    if any(entry["license"] in ("Unknown", "Ignore") for entry in evidence["crates"]):
        raise ValueError("cargo-about returned unresolved or ignored licenses")
    sections = [
        "Herdr GPUI - Third-Party Notices\n",
        f"Generated with {ABOUT_VERSION}.\n"
        "Scope: locked workspace, all features, including build/dev dependencies;\n"
        "union of aarch64/x86_64 macOS, GNU/Linux, and Windows packaging\n"
        "targets (about.toml).\n"
        "Includes packages not linked into every binary. System libraries, nested\n"
        "vendored code and non-Cargo assets require separate review. This report\n"
        "is not legal approval or a completeness determination.\n\n"
        "License texts use cargo-about evidence where available, otherwise its\n"
        "pinned canonical SPDX corpus. Canonical texts do not identify all upstream\n"
        "copyright holders. Available source license/NOTICE files follow verbatim.\n\n"
        "MPL-covered dependencies remain MPL-2.0, not the project's Apache license.\n"
        "Their unmodified sources are available at the versioned URLs below.\n",
        f"Cargo.lock SHA-256: {hashlib.sha256(lock_bytes).hexdigest()}\n",
        f"Packages (including workspace): {len(packages)}\n",
    ]
    for license in sorted(licenses, key=lambda item: (item["id"], item["text"])):
        if not license["text"].strip() or not license["used_by"]:
            raise ValueError("cargo-about returned empty license evidence")
        origin = "collected license evidence" if license.get("source_path") else "canonical SPDX text"
        sections.append(f"\n{'=' * 78}\n{license['name']} ({license['id']})\nEvidence: {origin}\nUsed by:")
        for use in sorted(license["used_by"], key=lambda use: (use["crate"]["name"], use["crate"]["version"])):
            package = use["crate"]
            if license["id"] == "MPL-2.0" and MPL_VERSIONS.get(package["name"]) != package["version"]:
                raise ValueError(f"MPL exception needs version review: {package['name']} {package['version']}")
            sections.append(f"  {package['name']} {package['version']}")
        sections.append(license["text"].rstrip() + "\n")
    sections.append("\nPACKAGE INVENTORY AND SUPPLEMENTAL SOURCE NOTICES\n")
    for package in packages:
        label = f"{package['name']} {package['version']}"
        texts = collect(package)
        sections.append(
            f"\n{'=' * 78}\n{label}\n"
            f"Source: {package.get('source') or 'local path dependency'}\n"
            f"Declared license: {package.get('license') or 'not specified; review license file'}\n"
        )
        if package.get("source", "") == "registry+https://github.com/rust-lang/crates.io-index":
            sections.append(f"Source download: https://crates.io/api/v1/crates/{package['name']}/{package['version']}/download\n")
        for name, text in texts:
            sections.append(f"\n--- {name} ---\n{text.rstrip()}\n")
    return "\n".join(sections)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new report path in an existing directory")
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        parser.error("output already exists; remove stale reports explicitly")
    lock = (ROOT / "Cargo.lock").read_bytes()
    version = subprocess.run(
        ["cargo", "about", "--version"], cwd=ROOT, check=True,
        stdout=subprocess.PIPE, text=True, encoding="utf-8",
    ).stdout.strip()
    if version != ABOUT_VERSION:
        raise ValueError(f"Required {ABOUT_VERSION}; found {version!r}. Install: {INSTALL}")
    result = subprocess.run(
        ["cargo", "about", "generate", "--locked", "--all-features", "--workspace", "--fail",
         "--config", str(ROOT / "scripts/release/about.toml"), "--format", "json"],
        cwd=ROOT, check=True, stdout=subprocess.PIPE,
    )
    report = render(json.loads(result.stdout), lock)
    if lock != (ROOT / "Cargo.lock").read_bytes():
        raise ValueError("Cargo.lock changed during generation")
    # No output is created until every package has passed collection.
    with args.output.open("x", encoding="utf-8", newline="\n") as output:
        output.write(report)
    print(f"Generated {args.output}; review before approving a public release.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        print(f"Notice generation failed. Required tool: {INSTALL}", file=sys.stderr)
        sys.exit(1)
