#!/usr/bin/env python3
"""Package an already signed iPhone app and a private HTTPS installation page."""
import argparse
from datetime import datetime, timezone
import html
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote, urlsplit


def run(*command):
    return subprocess.run(command, check=True, capture_output=True)


def verify(app, udid):
    run("codesign", "--verify", "--deep", "--strict", str(app))
    bundles = [app, *app.glob("PlugIns/*.appex")]
    for bundle in bundles:
        profile = plistlib.loads(run("security", "cms", "-D", "-i",
                                     str(bundle / "embedded.mobileprovision")).stdout)
        if udid not in profile.get("ProvisionedDevices", []):
            raise ValueError(f"{bundle.name} is not provisioned for the requested iPhone.")
        if profile["ExpirationDate"].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
            raise ValueError(f"The provisioning profile for {bundle.name} has expired.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--device-udid", required=True, help="Hardware UDID, not the CoreDevice UUID")
    parser.add_argument("--base-url", required=True, help="HTTPS URL of the output directory")
    parser.add_argument("--output", type=Path, required=True, help="New directory containing only delivery assets")
    parser.add_argument("--note", default="The latest Phren for your iPhone.")
    args = parser.parse_args()
    app = args.app.expanduser().resolve()
    output = args.output.expanduser().resolve()
    base = args.base_url.rstrip("/")
    url = urlsplit(base)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment):
        raise ValueError("The base URL must be an HTTPS directory URL without credentials, query, or fragment.")
    if not app.is_dir() or app.suffix != ".app":
        raise ValueError("Provide the signed .app from a device build.")
    if output.exists():
        raise ValueError("Use a new output directory so existing install links remain valid.")
    verify(app, args.device_udid)
    info = plistlib.loads((app / "Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.phren.ios":
        raise ValueError("Expected the com.phren.ios app bundle.")
    if info.get("DTPlatformName") != "iphoneos":
        raise ValueError("A simulator app cannot be installed on an iPhone.")

    # Stage outside the served directory, including a round-trip signature check.
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="phren-ota-") as temporary:
        stage = Path(temporary)
        payload = stage / "Payload"
        payload.mkdir()
        run("ditto", "--norsrc", "--noextattr", "--noqtn", str(app), str(payload / app.name))
        delivery = stage / "delivery"
        delivery.mkdir()
        ipa = delivery / "Phren.ipa"
        run("ditto", "-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--keepParent",
            str(payload), str(ipa))
        unpacked = stage / "unpacked"
        run("ditto", "-x", "-k", str(ipa), str(unpacked))
        verify(unpacked / "Payload" / app.name, args.device_udid)

        assets = [{"kind": "software-package", "url": base + "/Phren.ipa"}]
        icon = app / "AppIcon60x60@2x.png"
        if icon.is_file():
            shutil.copyfile(icon, delivery / "icon.png")
            assets.append({"kind": "display-image", "url": base + "/icon.png", "needs-shine": False})
        manifest = {"items": [{"assets": assets, "metadata": {
            "bundle-identifier": info["CFBundleIdentifier"],
            "bundle-version": info["CFBundleVersion"],
            "kind": "software", "title": "Phren",
        }}]}
        (delivery / "manifest.plist").write_bytes(plistlib.dumps(manifest))
        install = "itms-services://?action=download-manifest&url=" + quote(base + "/manifest.plist", safe="")
        version = html.escape(str(info["CFBundleShortVersionString"]))
        build_number = html.escape(str(info["CFBundleVersion"]))
        note = html.escape(args.note)
        icon_tag = '<img src="icon.png" alt="" width="88" height="88">' if icon.is_file() else ""
        (delivery / "index.html").write_text(f'''<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Install Phren</title>
<style>
body{{margin:0;background:#0c0a18;color:#f1edff;font:17px/1.55 -apple-system,BlinkMacSystemFont,sans-serif}}
main{{max-width:420px;padding:64px 28px;margin:auto}}img{{border-radius:22px}}
h1{{font-size:38px;letter-spacing:-1px;margin:20px 0 4px}}p{{color:#bbb3cf}}
a{{display:block;background:#aa82ff;color:#150d29;text-align:center;text-decoration:none;
font-weight:700;padding:16px;border-radius:16px;margin:30px 0}}small{{color:#8e86a4}}
</style><main>{icon_tag}<h1>Phren for iPhone</h1><small>Version {version} · Build {build_number}</small>
<p>{note}</p><a href="{html.escape(install, quote=True)}">Install Phren</a>
<p>Open this page in Safari with Tailscale connected. Tap Install Phren, then confirm Install.</p>
<p>Once the download finishes, open Phren from your Home Screen.</p>
</main></html>
''')
        shutil.copytree(delivery, output)
    print(f"Verified iPhone package: {output / 'Phren.ipa'}")
    print(f"Serve this directory over HTTPS, then open: {base}/")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        if error.stderr:
            print(error.stderr.decode(errors="replace"), file=sys.stderr)
        sys.exit(f"Packaging command failed: {error.cmd[0]} (exit {error.returncode}).")
    except (OSError, ValueError, KeyError) as error:
        sys.exit(str(error))
