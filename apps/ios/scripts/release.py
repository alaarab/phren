#!/usr/bin/env python3
"""Create a signed archive, then optionally export or upload it to TestFlight."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--team", help="Apple team id; overrides the environment and every xcconfig")
parser.add_argument("--client-id", help="GitHub OAuth client id; overrides the environment and every xcconfig")
parser.add_argument("--build-number", required=True, type=int)
parser.add_argument("--output", type=Path, default=Path.home() / "Library/Developer/Xcode/Archives/phren")
parser.add_argument("--allow-token-sign-in", action="store_true", help="Permit a build with only personal-token sign-in")
export = parser.add_mutually_exclusive_group()
export.add_argument("--export", action="store_true", help="Export a signed IPA for App Store Connect")
export.add_argument("--upload", action="store_true", help="Upload the archive to App Store Connect for TestFlight")


def prune_archives(root, keep=3):
    """Delete archive directories under `root` beyond the newest `keep`.

    Each `build-<n>` directory holds one .xcarchive, so directories are the
    archives; stray files are left alone and a missing root prunes nothing.
    """
    if not root.is_dir():
        return []
    directories = sorted(
        (entry for entry in root.iterdir() if entry.is_dir()),
        key=lambda entry: entry.stat().st_mtime,
        reverse=True,
    )
    removed = []
    for stale in directories[keep:]:
        shutil.rmtree(stale)
        removed.append(stale)
    return removed


root = Path(__file__).resolve().parents[1]


def run(command, **kwargs):
    return subprocess.run(command, cwd=root, check=True, **kwargs)


def read_xcconfig(path, key):
    """The value assigned to `key` in an xcconfig file, or None when unset."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    assignment = re.compile(rf"^\s*{re.escape(key)}\s*=\s*(.*?)\s*$")
    for line in lines:
        match = assignment.match(line.split("//", 1)[0])
        if match:
            value = match.group(1).strip().strip('"').strip()
            if value:
                return value
    return None


def xcconfig_candidates(checkout):
    """Git-ignored per-user signing configs, most specific first.

    `Config/App.xcconfig` includes `Local.xcconfig`; the checked-in example
    lives in `Config/`, while an existing install may keep the real file
    beside `project.yml` instead.
    """
    return [checkout / "Config/Local.xcconfig", checkout / "Local.xcconfig"]


def find_main_worktree():
    """This checkout's directory inside the repository's main worktree.

    `git worktree list --porcelain` names the main checkout's root, while
    `root` here is the `apps/ios` subdirectory, so map the same relative path
    onto it. Returns None when this is not a git worktree.
    """
    try:
        top = Path(subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], cwd=root,
            capture_output=True, text=True, check=True,
        ).stdout.strip())
        listing = subprocess.run(
            ["git", "worktree", "list", "--porcelain"], cwd=root,
            capture_output=True, text=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    main_root = None
    for line in listing.splitlines():
        if line.startswith("worktree "):
            main_root = Path(line[len("worktree "):].strip())
            break
    if main_root is None:
        return None
    try:
        relative = root.resolve().relative_to(top.resolve())
    except ValueError:
        return None
    return main_root / relative


def resolved_build_settings(checkout, settings):
    """The Phren target's build settings as xcodebuild resolves them in `checkout`."""
    subprocess.run(["xcodegen", "generate"], cwd=checkout, check=True)
    resolved = json.loads(subprocess.run(
        ["xcodebuild", "-project", "Phren.xcodeproj", "-scheme", "Phren", "-configuration", "Release",
         "-showBuildSettings", "-json", *settings],
        cwd=checkout, capture_output=True, text=True, check=True,
    ).stdout)
    return next(target["buildSettings"] for target in resolved if target["target"] == "Phren")


def resolve_setting(key, *, env, checkout, main_worktree, remote_settings):
    """Resolve a build setting the way Xcode does, from any checkout.

    Order: the environment variable, this checkout's git-ignored
    `Local.xcconfig`, the main worktree's `Local.xcconfig`, then the main
    worktree's resolved xcodebuild settings. `remote_settings` is called
    lazily and returns the main worktree's build settings. Returns
    `(value, source)`, with an empty value and None source when nothing
    supplies it.
    """
    if env:
        return env, "environment"
    for path in xcconfig_candidates(checkout):
        value = read_xcconfig(path, key)
        if value:
            return value, str(path)
    if main_worktree is not None and main_worktree != checkout:
        for path in xcconfig_candidates(main_worktree):
            value = read_xcconfig(path, key)
            if value:
                return value, str(path)
    if main_worktree is not None:
        value = remote_settings().get(key, "").strip()
        if value:
            return value, f"{main_worktree} build settings"
    return "", None


def main() -> None:
    args = parser.parse_args()
    if args.build_number < 1:
        parser.error("Build number must be positive and higher than the last uploaded build.")

    import changelog
    version = changelog.require_entry()
    print(f"Archiving Phren {version} build {args.build_number}.", flush=True)
    run(["xcodegen", "generate"])
    settings = [f"CURRENT_PROJECT_VERSION={args.build_number}", "CODE_SIGN_STYLE=Automatic"]
    main_worktree = find_main_worktree()
    remote_cache = {}

    def remote_settings():
        # Only reached when no Local.xcconfig supplies the value; resolving the
        # main checkout's settings is the slowest source, so keep it lazy.
        if "value" not in remote_cache:
            remote_cache["value"] = resolved_build_settings(main_worktree, settings) if main_worktree else {}
        return remote_cache["value"]

    team, team_source = resolve_setting(
        "DEVELOPMENT_TEAM", env=os.environ.get("PHREN_APPLE_TEAM_ID"),
        checkout=root, main_worktree=main_worktree, remote_settings=remote_settings,
    )
    if args.team:
        team, team_source = args.team, "--team"
    client_id, client_source = resolve_setting(
        "PHREN_GITHUB_CLIENT_ID", env=os.environ.get("PHREN_GITHUB_CLIENT_ID"),
        checkout=root, main_worktree=main_worktree, remote_settings=remote_settings,
    )
    if args.client_id:
        client_id, client_source = args.client_id, "--client-id"
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        parser.error("Set PHREN_APPLE_TEAM_ID, DEVELOPMENT_TEAM in Local.xcconfig, or pass --team.")
    configured = bool(re.fullmatch(r"[A-Za-z0-9._-]+", client_id)) and not client_id.startswith(("YOUR_", "REPLACE_WITH_"))
    if not configured and not args.allow_token_sign_in:
        parser.error("Set a registered OAuth client ID, or explicitly use --allow-token-sign-in.")
    print(f"team {team} from {team_source}")
    if client_id:
        print(f"client id {client_id} from {client_source}")
    settings.append(f"DEVELOPMENT_TEAM={team}")
    if client_id:
        settings.append(f"PHREN_GITHUB_CLIENT_ID={client_id}")

    output = args.output.expanduser().resolve() / f"build-{args.build_number}"
    archive = output / "Phren.xcarchive"
    if archive.exists():
        parser.error(f"Archive already exists: {archive}. Choose another build number or output directory.")
    output.mkdir(parents=True, exist_ok=True)
    base = ["xcodebuild", "-project", "Phren.xcodeproj", "-scheme", "Phren", "-configuration", "Release"]
    run(base + ["archive", "-destination", "generic/platform=iOS", "-archivePath", str(archive),
                "-allowProvisioningUpdates", "-skipPackagePluginValidation"] + settings)
    print(f"Signed archive: {archive}")
    if args.export or args.upload:
        options = output / "ExportOptions.plist"
        options.write_bytes(plistlib.dumps({
            "method": "app-store-connect", "teamID": team, "signingStyle": "automatic",
            "destination": "upload" if args.upload else "export", "manageAppVersionAndBuildNumber": False,
            "uploadSymbols": True,
        }))
        # An App Store Connect API key (~/.config/ios-release.json: key_id,
        # issuer_id, key_path) lets the export and upload run without an Apple ID
        # signed into Xcode; the same file the deploy script reads.
        authentication = []
        credentials = Path.home() / ".config/ios-release.json"
        if credentials.exists():
            saved = json.loads(credentials.read_text())
            key_path = Path(saved.get("key_path", "")).expanduser()
            if saved.get("key_id") and saved.get("issuer_id") and key_path.exists():
                authentication = ["-authenticationKeyPath", str(key_path), "-authenticationKeyID", saved["key_id"],
                                  "-authenticationKeyIssuerID", saved["issuer_id"]]
        run(["xcodebuild", "-exportArchive", "-archivePath", str(archive), "-exportPath", str(output / "export"),
             "-exportOptionsPlist", str(options), "-allowProvisioningUpdates"] + authentication)
        print("Uploaded to App Store Connect; wait for processing in TestFlight." if args.upload else f"Exported IPA: {output / 'export'}")
        if args.upload:
            # A successful upload is the moment old archives are safe to drop;
            # the newest three stay on this machine for a re-upload.
            for stale in prune_archives(args.output.expanduser().resolve()):
                print(f"Pruned old archive: {stale}")


if __name__ == "__main__":
    main()
