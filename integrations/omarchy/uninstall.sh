#!/bin/bash
# Remove the phren plugin and its launcher entries from Omarchy.
set -u
omarchy-plugin-disable phren >/dev/null 2>&1 || true
rm -rf "$HOME/.config/omarchy/plugins/phren"
omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
omarchy-tui-remove "phren" >/dev/null 2>&1 || rm -f "$HOME/.local/share/applications/phren.desktop"
omarchy-webapp-remove "phren graph" >/dev/null 2>&1 || rm -f "$HOME/.local/share/applications/phren graph.desktop"
echo "phren removed from Omarchy."
