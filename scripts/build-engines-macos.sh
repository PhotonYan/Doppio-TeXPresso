#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This installer targets macOS.' >&2
  exit 1
fi

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="$root/.real-time-latex/bin"
flash_revision=28cb0d7b80a8f01bf60e196112663d5a0be744e7
texpresso_revision="$(git -C "$root" rev-parse HEAD:native/texpresso)"
export PATH="/Library/TeX/texbin:$(brew --prefix)/bin:$PATH"
command -v kpsewhich >/dev/null
command -v mutool >/dev/null
command -v cargo >/dev/null

mkdir -p "$install_dir"
work="$(mktemp -d "$root/.real-time-latex/build.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

fetch_patched() {
  local name="$1" url="$2" revision="$3"
  local checkout="$work/$name"
  git init -q "$checkout"
  if ! git -C "$checkout" fetch --depth 1 "$url" "$revision"; then
    git -C "$checkout" -c http.version=HTTP/1.1 fetch --depth 1 "$url" "$revision"
  fi
  git -C "$checkout" checkout -q --detach FETCH_HEAD
  git -C "$checkout" apply "$root/native/patches/$name.patch"
}

fetch_patched texpresso https://github.com/DominikPeters/texpresso.git "$texpresso_revision"
make -C "$work/texpresso" config
make -C "$work/texpresso" -j "$(sysctl -n hw.activecpu)" BREW_ICU4C="$(brew --prefix icu4c@78)" all

fetch_patched flashtex https://github.com/flash-tex/flashtex.git "$flash_revision"
(
  cd "$work/flashtex"
  cargo build --locked --release -p flashtex-engine --bin flashtex-host --bin flashtex-initex
)

install -m 755 "$work/texpresso/build/texpresso" "$work/texpresso/build/texpresso-xetex" "$install_dir"
install -m 755 "$work/flashtex/target/release/flashtex-host" "$work/flashtex/target/release/flashtex-initex" "$install_dir"
cat > "$install_dir/texpresso-realtime" <<'LAUNCHER'
#!/bin/sh
set -eu
export PATH="/Library/TeX/texbin:$PATH"
bin="$(cd "$(dirname "$0")" && pwd)"
exec "$bin/texpresso" "$@"
LAUNCHER
chmod 755 "$install_dir/texpresso-realtime"

python3 - "$install_dir" "$(command -v mutool)" <<'PYTHON'
import json
import sys
from pathlib import Path

bin_path = Path(sys.argv[1])
print('Paste these settings into VS Code (Preferences: Open User Settings (JSON)).')
print(json.dumps({
    'texpresso.command': str(bin_path / 'texpresso-realtime'),
    'texpresso.packageProvider': 'texlive',
    'texpresso.previewLocation': 'editor',
    'texpresso.flashtexHost': str(bin_path / 'flashtex-host'),
    'texpresso.flashtexMutool': sys.argv[2]
}, indent=2))
PYTHON
