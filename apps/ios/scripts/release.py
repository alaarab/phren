#!/usr/bin/env python3
"""Create a signed archive, then optionally export or upload it to TestFlight."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--team", default=os.environ.get("PHREN_APPLE_TEAM_ID"))
parser.add_argument("--client-id", default=os.environ.get("PHREN_GITHUB_CLIENT_ID"))
parser.add_argument("--build-number", required=True, type=int)
parser.add_argument("--output", type=Path, default=Path.home() / "Library/Developer/Xcode/Archives/phren")
parser.add_argument("--allow-token-sign-in", action="store_true", help="Permit a build with only personal-token sign-in")
export = parser.add_mutually_exclusive_group()
export.add_argument("--export", action="store_true", help="Export a signed IPA for App Store Connect")
export.add_argument("--upload", action="store_true", help="Upload the archive to App Store Connect for TestFlight")
args = parser.parse_args()
if args.build_number < 1:
    parser.error("Build number must be positive and higher than the last uploaded build.")

root = Path(__file__).resolve().parents[1]
def run(command, **kwargs):
    return subprocess.run(command, cwd=root, check=True, **kwargs)

import changelog
version = changelog.require_entry()
print(f"Archiving Phren {version} build {args.build_number}.", flush=True)
run(["xcodegen", "generate"])
settings = [f"CURRENT_PROJECT_VERSION={args.build_number}", "CODE_SIGN_STYLE=Automatic"]
if args.team:
    settings.append(f"DEVELOPMENT_TEAM={args.team}")
if args.client_id:
    settings.append(f"PHREN_GITHUB_CLIENT_ID={args.client_id}")
base = ["xcodebuild", "-project", "Phren.xcodeproj", "-scheme", "Phren", "-configuration", "Release"]
resolved = json.loads(run(base + ["-showBuildSettings", "-json"] + settings, capture_output=True, text=True).stdout)
app = next(target["buildSettings"] for target in resolved if target["target"] == "Phren")
team = app.get("DEVELOPMENT_TEAM", "")
client_id = app.get("PHREN_GITHUB_CLIENT_ID", "").strip()
if not re.fullmatch(r"[A-Z0-9]{10}", team):
    parser.error("Set DEVELOPMENT_TEAM in Config/Local.xcconfig or pass --team.")
configured = bool(re.fullmatch(r"[A-Za-z0-9._-]+", client_id)) and not client_id.startswith(("YOUR_", "REPLACE_WITH_"))
if not configured and not args.allow_token_sign_in:
    parser.error("Set a registered OAuth client ID, or explicitly use --allow-token-sign-in.")

output = args.output.expanduser().resolve() / f"build-{args.build_number}"
archive = output / "Phren.xcarchive"
if archive.exists():
    parser.error(f"Archive already exists: {archive}. Choose another build number or output directory.")
output.mkdir(parents=True, exist_ok=True)
run(base + ["archive", "-destination", "generic/platform=iOS", "-archivePath", str(archive),
            "-allowProvisioningUpdates"] + settings)
print(f"Signed archive: {archive}")
if args.export or args.upload:
    options = output / "ExportOptions.plist"
    options.write_bytes(plistlib.dumps({
        "method": "app-store-connect", "teamID": team, "signingStyle": "automatic",
        "destination": "upload" if args.upload else "export", "manageAppVersionAndBuildNumber": False,
        "uploadSymbols": True,
    }))
    run(["xcodebuild", "-exportArchive", "-archivePath", str(archive), "-exportPath", str(output / "export"),
         "-exportOptionsPlist", str(options), "-allowProvisioningUpdates"])
    print("Uploaded to App Store Connect; wait for processing in TestFlight." if args.upload else f"Exported IPA: {output / 'export'}")
