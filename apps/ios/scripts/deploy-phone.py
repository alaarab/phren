#!/usr/bin/env python3
"""Build, verify, install, and launch Phren on a paired iPhone."""
import argparse
import time
from contextlib import contextmanager
import json
import os
from pathlib import Path
import changelog
import plistlib
import re
import shlex
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(*command, **options):
    return subprocess.run(command, cwd=ROOT, check=True, **options)


@contextmanager
def signing(config):
    """Reuse an existing unattended signing helper; never handle its password.

    The helper's `unlock` prints only its keychain path and prioritizes that
    keychain. `lock` locks it and restores the prior search list. The shared
    mkdir lock also coordinates with other apps using the same helper.
    """
    if not config.get("signing_helper"):
        yield []
        return
    helper = Path(config["signing_helper"]).expanduser().resolve()
    lock = Path(config["signing_lock_directory"]).expanduser().resolve()
    if not helper.is_file() or not os.access(helper, os.X_OK):
        raise ValueError("The configured signing helper is not executable.")
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        raise ValueError(f"Another signing operation holds {lock}. Wait for it to finish.") from None
    try:
        (lock / "pid").write_text(str(os.getpid()) + "\n")
        keychain = run(str(helper), "unlock", capture_output=True, text=True).stdout.strip()
        if "\n" in keychain or not Path(keychain).is_file():
            raise ValueError("The signing helper did not return a keychain path.")
        yield [f"OTHER_CODE_SIGN_FLAGS=--keychain {shlex.quote(keychain)}"]
    finally:
        try:
            run(str(helper), "lock")
        finally:
            (lock / "pid").unlink(missing_ok=True)
            lock.rmdir()


def build(command, log_path):
    # On interruption stop Xcode before the context manager relocks its key.
    with log_path.open("w") as log:
        process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            status = process.wait()
        except BaseException:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            raise
    if status:
        raise RuntimeError(f"Xcode build failed. See {log_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", help="Override the paired device in Local.deploy.json")
    parser.add_argument("--build-only", action="store_true", help="Prepare and verify the signed app without a connected iPhone")
    parser.add_argument("--build-number", type=int, help="A new positive build number for both app and widget (otherwise increments the previous local device build)")
    parser.add_argument("--config", type=Path, default=ROOT / "Local.deploy.json")
    args = parser.parse_args()
    if not args.config.exists():
        raise ValueError("Copy Local.deploy.json.example to Local.deploy.json and configure this Mac first.")
    config = json.loads(args.config.read_text())
    device = args.device or config.get("device")
    team = config.get("team", "")
    if (not device and not args.build_only) or not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise ValueError("Set the paired device and Apple development team in Local.deploy.json.")
    derived = Path(config.get("derived_data", "~/Library/Developer/Xcode/DerivedData/PhrenPhone")).expanduser().resolve()
    derived.mkdir(parents=True, exist_ok=True)
    log_path = derived / "deploy-build.log"
    app = derived / "Build/Products/Release-iphoneos/Phren.app"
    if args.build_number is not None and args.build_number < 1:
        raise ValueError("Build number must be positive.")
    previous = 0
    if (app / "Info.plist").exists():
        previous = int(plistlib.loads((app / "Info.plist").read_bytes())["CFBundleVersion"])
    number = args.build_number if args.build_number is not None else previous + 1
    if number <= previous:
        raise ValueError(f"Choose a build number higher than the previous local build ({previous}).")
    if not args.build_only:
        run("xcrun", "devicectl", "device", "info", "lockState", "--device", device, "--timeout", "30")
    # Every build carries a changelog entry for its version, or it does not build.
    version = changelog.require_entry()
    run("xcodegen", "generate")
    with signing(config) as settings:
        print(f"Building and signing Phren {version} build {number}. Build log: {log_path}", flush=True)
        build([
            "xcodebuild", "build", "-skipPackagePluginValidation", "-project", "Phren.xcodeproj", "-scheme", "Phren",
            "-configuration", "Release", "-destination", "generic/platform=iOS",
            "-derivedDataPath", str(derived), "-allowProvisioningUpdates",
            "CODE_SIGN_STYLE=Automatic", f"DEVELOPMENT_TEAM={team}", f"CURRENT_PROJECT_VERSION={number}", *settings,
        ], log_path)
    run("codesign", "--verify", "--deep", "--strict", str(app))
    if args.build_only:
        print(f"Signed app ready: {app}")
        return
    run("xcrun", "devicectl", "device", "install", "app", "--device", device, str(app), "--timeout", "120")
    print("Phren installed. Launching…", flush=True)
    # Right after an install, launching can fail transiently with
    # CoreDeviceError 10002 / FBSOpenApplicationServiceErrorDomain error 1 while
    # the previous instance is still being torn down — it reads like a locked
    # phone but a retry a few seconds later succeeds.
    for attempt in range(3):
        try:
            run("xcrun", "devicectl", "device", "process", "launch", "--device", device,
                "--terminate-existing", "com.phren.ios", "--timeout", "30")
            break
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            print("Launch not accepted yet; retrying…", flush=True)
            time.sleep(4)
    print("Phren installed and launched.")


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("Deployment interrupted.")
    except subprocess.CalledProcessError as error:
        # Helper stderr contains diagnostics, never credential values.
        if error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(f"Deployment command failed: {error.cmd[0]} (exit {error.returncode}).")
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        sys.exit(str(error))
