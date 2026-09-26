#!/usr/bin/env bash
# Installs usage-stats on Linux, macOS, or WSL:
#   1. Bun into ~/.bun when it is missing (no sudo needed)
#   2. the project dependencies
#   3. the `usage-stats` command into ~/.local/bin
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

if [[ ! -x "$BUN" ]]; then
  echo "Installing Bun into ~/.bun ..."
  if command -v unzip >/dev/null; then
    curl -fsSL https://bun.sh/install | bash
  else
    # the official script needs unzip, fall back to a manual download
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64)  target=linux-x64 ;;
      Linux-aarch64) target=linux-aarch64 ;;
      Darwin-arm64)  target=darwin-aarch64 ;;
      Darwin-x86_64) target=darwin-x64 ;;
      *) echo "Unsupported platform, install Bun from https://bun.sh" >&2; exit 1 ;;
    esac
    if [[ "$target" == linux-x64 ]] && ! grep -q avx2 /proc/cpuinfo; then
      target=linux-x64-baseline
    fi
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/latest/download/bun-$target.zip"
    python3 -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$tmp/bun.zip" "$tmp"
    mkdir -p "$HOME/.bun/bin"
    mv "$tmp/bun-$target/bun" "$HOME/.bun/bin/bun"
    chmod +x "$HOME/.bun/bin/bun"
    rm -rf "$tmp"
  fi
  BUN="$HOME/.bun/bin/bun"
fi

# --omit=peer skips OpenTUI's required-but-unused peers (typescript,
# react-devtools-core, web-tree-sitter): 30 MB instead of 75 MB
echo "Installing dependencies ..."
(cd "$ROOT" && "$BUN" install --frozen-lockfile --production --omit=peer)

# dtach keeps `usage-stats --bg` running with the vendor logos visible (tmux
# cannot forward Kitty graphics). On Debian/Ubuntu it is fetched into
# ~/.local/bin without sudo; elsewhere install it with your package manager.
if ! command -v dtach >/dev/null; then
  if command -v apt-get >/dev/null && command -v dpkg >/dev/null; then
    echo "Installing dtach into ~/.local/bin ..."
    tmp="$(mktemp -d)"
    if (cd "$tmp" && apt-get download dtach >/dev/null 2>&1) && dpkg -x "$tmp"/dtach_*.deb "$tmp/x"; then
      mkdir -p "$HOME/.local/bin"
      install -m 755 "$tmp/x/usr/bin/dtach" "$HOME/.local/bin/dtach"
    else
      echo "  could not fetch dtach, --bg will use tmux (logos show as colored dots there)"
    fi
    rm -rf "$tmp"
  else
    echo "Optional: install dtach (e.g. brew install dtach) so --bg can show the vendor logos"
  fi
fi

chmod +x "$ROOT/bin/usage-stats"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/usage-stats" "$HOME/.local/bin/usage-stats"

for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [[ -f "$rc" ]] || continue
  grep -q '.bun/bin' "$rc" || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$rc"
  grep -q '.local/bin' "$rc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
done

if grep -qi microsoft /proc/version 2>/dev/null; then
  echo
  echo "Optional, WSL + Windows Terminal: give usage-stats pr-stats' look (IBM Plex Mono,"
  echo "VS Code colors) as its own Windows Terminal profile, used by 'usage-stats --wt':"
  echo "  from the project folder: bash scripts/install-wt-profile.sh"
fi

echo
echo "Done. Open a new terminal (or: source ~/.bashrc) and run:"
echo "  usage-stats          # in this terminal"
echo "  usage-stats --bg     # keep it running in the background (dtach, or tmux)"
