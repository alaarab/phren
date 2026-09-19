#!/usr/bin/env python3
"""Tiny App Store Connect API client: signs a JWT with the key in ~/.config/ios-release.json.
Usage: asc.py GET|POST|PATCH|DELETE </v1/path> [json body]. Prints the JSON reply."""
import json, time, os, sys, urllib.request, jwt
cfg = json.load(open(os.path.expanduser('~/.config/ios-release.json')))
def token():
    return jwt.encode({"iss": cfg["issuer_id"], "iat": int(time.time()), "exp": int(time.time())+600, "aud": "appstoreconnect-v1"},
                      open(os.path.expanduser(cfg["key_path"])).read(), algorithm="ES256", headers={"kid": cfg["key_id"]})
def call(method, path, body=None):
    req = urllib.request.Request("https://api.appstoreconnect.apple.com" + path, method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return json.load(r) if r.status != 204 else {}
    except urllib.error.HTTPError as e:
        print(method, path, e.code, e.read().decode()[:600]); return None
if __name__ == "__main__":
    print(json.dumps(call(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else None)))
