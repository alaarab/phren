#!/bin/bash
# Install the phren plugin into Omarchy from a checkout of the phren repo.
#
#   bash integrations/omarchy/install.sh
#
# Copies the plugin to ~/.config/omarchy/plugins/phren (where Omarchy looks
# for user plugins), validates it with Omarchy's own checker, enables it in the
# running shell when one is reachable, and registers phren in the app launcher
# (SUPER + SPACE): "phren" opens the shell in a floating terminal, "phren graph"
# opens the web viewer as an app window.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
target="$HOME/.config/omarchy/plugins/phren"
phren_bin=$(command -v phren 2>/dev/null || echo "$HOME/.local/bin/phren")

command -v omarchy-plugin-validate >/dev/null || { echo "This is not an Omarchy machine (omarchy-plugin-validate not found)."; exit 1; }
[[ -x $phren_bin ]] || echo "warning: phren is not installed yet (run: npx @phren/cli init); the launchers will work once it is."

omarchy-plugin-validate "$here"

mkdir -p "$(dirname "$target")"
rm -rf "$target"
cp -r "$here" "$target"
chmod +x "$target"/bin/*
omarchy-plugin-validate "$target"
echo "Plugin copied to $target"

# App launcher entries. omarchy-tui-install wants an icon file, a name, a
# command and a window style; omarchy-webapp-install takes a custom exec so the
# web viewer starts phren's server before opening the window.
omarchy-tui-install "phren" "$phren_bin shell" float "$here/assets/phren.png"
omarchy-webapp-install "phren graph" "http://127.0.0.1:3499" "$here/assets/phren.png" "$target/bin/phren-omarchy-launch web 3499"
echo "Launcher entries added: phren, phren graph"

if omarchy-shell shell rescanPlugins >/dev/null 2>&1; then
  omarchy-plugin-enable phren right >/dev/null 2>&1 && echo "Enabled in the bar (right section)." || echo "Enable it with: omarchy plugin enable phren"
else
  echo "Omarchy shell not reachable from this terminal. Enable with: omarchy plugin enable phren"
fi
