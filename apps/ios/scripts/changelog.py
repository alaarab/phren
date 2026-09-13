#!/usr/bin/env python3
"""The app's version and its changelog entry, shared by the build scripts.

`marketing_version()` reads MARKETING_VERSION from project.yml. `require_entry`
refuses to build a version that CHANGELOG.md does not describe, so the in-app
"What's new" never comes up empty. Run directly to check.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def marketing_version():
    versions = set(re.findall(r'^\s*MARKETING_VERSION:\s*"([^"]+)"', (ROOT / "project.yml").read_text(), re.M))
    if len(versions) != 1:
        raise ValueError(f"project.yml must set one MARKETING_VERSION for every target, found {sorted(versions)}.")
    return versions.pop()


def entry(version):
    """The changelog section for `version`, or None."""
    text = (ROOT / "CHANGELOG.md").read_text()
    match = re.search(rf"^## {re.escape(version)}\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    return match.group(1).strip() if match else None


def require_entry():
    version = marketing_version()
    body = entry(version)
    if not body:
        raise SystemExit(f"CHANGELOG.md has no section for {version}. Add '## {version}' with what changed before building.")
    if not re.search(r"^- ", body, re.M):
        raise SystemExit(f"CHANGELOG.md's {version} section has no bullet points yet.")
    return version


if __name__ == "__main__":
    print(f"{require_entry()} has a changelog entry.")
    sys.exit(0)
