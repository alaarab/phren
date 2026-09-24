#!/usr/bin/env python3
"""Compatibility entry point for the retired Python chat helper installer."""
import os
import sys
if len(sys.argv) > 1:
    raise SystemExit("Use: npx --yes @phren/cli@0.2.12 bridge install")
os.execvp("npx", ["npx", "--yes", "@phren/cli@0.2.12", "bridge", "install"])
