#!/usr/bin/env bash
# Build VS Code's remote extension host (REH, MIT, from microsoft/vscode) at the
# exact commit monaco-vscode-api was built from, so Phren desktop's editor can
# run Node extensions. Microsoft's own VS Code Server is licensed only for VS Code
# clients, and VSCodium's prebuilt servers lag our version, hence this build.
#
#   build-reh.sh [platform-arch]     e.g. darwin-arm64 (default: this machine), linux-x64
#
# Output: $PHREN_REH_BUILD/out/vscode-reh-<platform-arch>-<version>.tar.gz
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
api_version="$(node -p "require('$here/package.json').dependencies['@codingame/monaco-vscode-api']")"
meta="$(curl -fsSL "https://raw.githubusercontent.com/CodinGame/monaco-vscode-api/v${api_version}/package.json")"
commit="$(printf '%s' "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).config.vscode.commit))')"
version="$(printf '%s' "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).config.vscode.version))')"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
[ "$arch" = "x86_64" ] && arch=x64; [ "$arch" = "aarch64" ] && arch=arm64
target="${1:-$os-$arch}"
root="${PHREN_REH_BUILD:-$HOME/.cache/phren/reh-build}"
src="$root/vscode-$commit"
mkdir -p "$root/out"
echo "VS Code $version ($commit) -> REH $target in $root"

# VS Code pins its build Node version in .nvmrc; use exactly that one.
if [ ! -d "$src/.git" ]; then
  git init -q "$src"
  git -C "$src" remote add origin https://github.com/microsoft/vscode.git
  git -C "$src" fetch -q --depth 1 origin "$commit"
  git -C "$src" checkout -q FETCH_HEAD
fi
node_version="$(cat "$src/.nvmrc")"
node_dir="$root/node-v$node_version-$os-$arch"
if [ ! -x "$node_dir/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-$os-$arch.tar.gz" | tar -xz -C "$root"
fi
export PATH="$node_dir/bin:$PATH"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 VSCODE_SKIP_NODE_VERSION_CHECK=1

cd "$src"
# A marker, not node_modules' existence: an interrupted install must run again.
if [ ! -f .phren-npm-ci-done ]; then
  npm ci --no-audit --no-fund
  touch .phren-npm-ci-done
fi
# The same steps as VS Code's vscode-reh-<target>-min task, but compiled without
# mangling (as VSCodium builds): the mangler refuses some upstream sources.
for step in compile-build-without-mangling clean-extensions-build compile-non-native-extensions-build \
  compile-copilot-extension-build compile-extension-media-build minify-vscode-reh "vscode-reh-$target-min-ci"; do
  echo "== $step"
  npm run gulp -- "$step"
done

out="$root/vscode-reh-$target"
[ -d "$out" ] || out="$(dirname "$src")/vscode-reh-$target"
# The client checks quality and commit; stamp them so the handshake matches.
node -e '
const fs=require("fs"), p=process.argv[1]+"/product.json", j=JSON.parse(fs.readFileSync(p));
j.commit=process.argv[2]; j.quality=j.quality||"stable"; fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$out" "$commit"
tarball="$root/out/vscode-reh-$target-$version.tar.gz"
tar -czf "$tarball" -C "$(dirname "$out")" "$(basename "$out")"
shasum -a 256 "$tarball" | tee "$tarball.sha256"
