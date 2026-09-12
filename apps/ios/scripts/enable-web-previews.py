#!/usr/bin/env python3
"""Legacy entry point: preview authorization is now managed by phren bridge install.

SSH port forwarding also permits Unix sockets, so broadening permitopen rules
cannot safely enable previews. The CLI installer migrates existing Phren keys
and installs the allowlisted web-preview dispatcher together.
"""
import sys


def main():
    print(
        "This legacy script no longer changes SSH authorization. "
        "Update Phren on this computer, then run phren bridge install. "
        "The installer removes forwarding permissions from existing Phren keys "
        "and enables previews through the restricted dispatcher.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
