#!/usr/bin/env python3
"""Install dependency declarations and upstream license/notice texts from build sources.

Run in the extracted application source after the offline install. This inventory
includes build-only and other-platform crates so it over-approximates the shipped
code. It records missing texts for human review; it does not grant permissions or
assert that all license combinations are compatible.
"""
import json
import re
import shutil
import sys
import tomllib
from pathlib import Path


def notice_files(directory):
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(directory)
        if "node_modules" in relative.parts or ".git" in relative.parts:
            continue
        if re.match(r"^(licen[cs]e|copying|copyright|notice)([.\-_].*|$)", path.name, re.I):
            yield path


def install_notices(destination):
    inventory = []
    packages = []
    for path in sorted(Path("cargo/vendor").glob("*/Cargo.toml")):
        metadata = tomllib.loads(path.read_text())["package"]
        packages.append(("cargo", path.parent, metadata))
    # Bun can hoist multiple versions into nested node_modules directories.
    for path in sorted(Path("node_modules").rglob("package.json")):
        relative = path.relative_to("node_modules")
        if not (len(relative.parts) == 2 or (len(relative.parts) >= 3 and relative.parts[-3].startswith("@")) or (len(relative.parts) >= 3 and relative.parts[-3] == "node_modules")):
            continue
        metadata = json.loads(path.read_text())
        if "name" in metadata and "version" in metadata:
            packages.append(("npm", path.parent, metadata))
    seen = set()
    for ecosystem, directory, metadata in packages:
        name, version = metadata["name"], metadata["version"]
        key = (ecosystem, name, version)
        if key in seen:
            continue
        seen.add(key)
        license_value = metadata.get("license", metadata.get("licenses"))
        target = destination / ecosystem / f'{name.replace("/", "__")}@{version}'
        texts = list(notice_files(directory))
        license_file = metadata.get("license-file")
        if license_file:
            path = directory / license_file
            if path.is_file() and path not in texts and path.resolve().is_relative_to(directory.resolve()):
                texts.append(path)
        installed = []
        for source in texts:
            relative = source.relative_to(directory)
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, output)
            installed.append(str(output.relative_to(destination)))
        inventory.append({
            "ecosystem": ecosystem, "name": name, "version": version,
            "license": license_value, "repository": metadata.get("repository"),
            "license_files": installed,
            "review_required": not license_value or not installed,
        })
    if not any(p["ecosystem"] == "cargo" for p in inventory) or not any(p["ecosystem"] == "npm" for p in inventory):
        raise RuntimeError("Both vendored Cargo and installed npm dependencies are required")
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "dependencies.json").write_text(json.dumps(inventory, indent=2) + "\n")
    lines = ["YuMusic dependency notices", "", "Includes build-only and other-platform dependencies.", "License texts are installed beside this inventory.", ""]
    for item in inventory:
        lines.append(f'{item["ecosystem"]}: {item["name"]}@{item["version"]} — {item["license"] or "UNDECLARED"}')
        lines.extend(f"  {path}" for path in item["license_files"])
        if item["review_required"]:
            lines.append("  REVIEW REQUIRED: missing declaration or packaged license text")
    (destination / "THIRD-PARTY-NOTICES.txt").write_text("\n".join(lines) + "\n")
    print(f"Installed notices for {len(inventory)} dependencies; {sum(p['review_required'] for p in inventory)} require review")


if __name__ == "__main__":
    install_notices(Path(sys.argv[1]))
