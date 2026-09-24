#!/usr/bin/env python3
"""Serve prepared iPhone installers on loopback, behind private Tailscale Serve."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


class InstallerHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".plist": "text/xml", ".ipa": "application/octet-stream"}

    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        parts = path.strip("/").split("/")
        if path.endswith("/"):
            parts.append("index.html")
        if (len(parts) != 2 or parts[0] in ("", ".", "..")
                or parts[1] not in {"index.html", "manifest.plist", "Phren.ipa", "icon.png"}):
            self.send_error(404)
            return None
        root = Path(self.directory).resolve()
        target = root.joinpath(*parts)
        # Deliver only actual files from the isolated output, never symlink targets.
        if target.resolve() != target or not target.is_file():
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--port", type=int, default=18763)
    args = parser.parse_args()
    directory = args.directory.expanduser().resolve()
    if not directory.is_dir():
        parser.error("The prepared installer directory does not exist.")
    handler = partial(InstallerHandler, directory=str(directory))
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Serving Phren installers on http://127.0.0.1:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
