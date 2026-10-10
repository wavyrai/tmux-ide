#!/usr/bin/env python3
"""Generate a CycloneDX union of default-feature release platform graphs."""

import json
import os
import pathlib
import shutil
import subprocess
import sys

TARGETS = ("aarch64-apple-darwin", "x86_64-apple-darwin",
           "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu",
           "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")


def main():
    output = pathlib.Path(sys.argv[1])
    env = dict(os.environ, RELEASE_CARGO=shutil.which("cargo"),
               CARGO=str(pathlib.Path("scripts/release/cargo-locked.sh").resolve()))
    components, dependencies = {}, {}
    bom = None
    for target in TARGETS:
        # Invoke the plugin directly: `cargo cyclonedx` overwrites our CARGO
        # wrapper environment variable before launching the plugin.
        subprocess.run([shutil.which("cargo-cyclonedx"), "cyclonedx", "--format", "json",
                        "--spec-version", "1.5", "--all", "--target", target,
                        "--override-filename", "sbom"], env=env, check=True)
        document = json.loads(pathlib.Path("crates/herdr-gpui/sbom.json").read_text())
        if document["bomFormat"] != "CycloneDX" or document["specVersion"] != "1.5":
            raise ValueError("Unexpected SBOM format")
        if not document.get("components") or not document.get("dependencies"):
            raise ValueError("Empty SBOM graph")
        if bom is None:
            bom = document
        elif bom["metadata"]["component"] != document["metadata"]["component"]:
            raise ValueError("Platform SBOM roots differ")
        for component in document["components"]:
            ref = component["bom-ref"]
            # A build-only dependency on one platform may be runtime on another.
            # Absent scope defaults conservatively to required; all other fields
            # must agree, including identity, hashes, and licenses.
            scopes = ("excluded", "optional", "required")
            scope = component.pop("scope", "required")
            if scope not in scopes:
                raise ValueError(f"Invalid SBOM component scope: {ref}")
            if ref in components:
                previous = components[ref].copy()
                previous_scope = previous.pop("scope")
                if previous != component:
                    raise ValueError(f"Conflicting SBOM component: {ref}")
                scope = max(scope, previous_scope, key=scopes.index)
            component["scope"] = scope
            components[ref] = component
        for dependency in document["dependencies"]:
            dependencies.setdefault(dependency["ref"], set()).update(dependency.get("dependsOn", []))
    bom["components"] = [components[ref] for ref in sorted(components)]
    bom["dependencies"] = [{"ref": ref, "dependsOn": sorted(edges)}
                           for ref, edges in sorted(dependencies.items())]
    refs = set(components) | {bom["metadata"]["component"]["bom-ref"]}
    if any(ref not in refs or not edges <= refs for ref, edges in dependencies.items()):
        raise ValueError("Dangling SBOM dependency reference")
    bom["metadata"]["properties"] = [{"name": "herdr:release:targets", "value": ",".join(TARGETS)}]
    output.write_text(json.dumps(bom, indent=2) + "\n")


if __name__ == "__main__":
    main()
