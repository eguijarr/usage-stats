#!/usr/bin/env bash
# Approximates the typography of pr-stats' screenshot (a VS Code terminal
# panel) in Windows Terminal, from WSL:
#   1. installs IBM Plex Mono for the current Windows user (no admin rights)
#   2. adds a "usage-stats" profile plus a "pr-stats" color scheme as a
#      Windows Terminal fragment, which leaves settings.json untouched
# `usage-stats --wt` then opens its pane with that profile.
#
# Undo: delete the usage-stats fragment folder, and remove the font
# under Settings > Personalization > Fonts.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
cmd="$(command -v cmd.exe || echo /mnt/c/Windows/System32/cmd.exe)"
powershell="$(command -v powershell.exe || echo /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe)"

if [[ ! -x "$cmd" || ! -x "$powershell" ]]; then
  echo "run this from WSL on a Windows machine" >&2
  exit 1
fi

profile="${USAGE_STATS_WINDOWS_HOME:-$(wslpath -u "$(cd / && "$cmd" /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")}"
local_app="$profile/AppData/Local"

# 1. fonts, per user: copy into the user's font folder and register them
fonts="$local_app/Microsoft/Windows/Fonts"
mkdir -p "$fonts"
for style in Regular Bold; do
  cp "$ROOT/assets/fonts/IBMPlexMono-$style.ttf" "$fonts/"
  suffix=""
  [[ $style == Bold ]] && suffix=" Bold"
  name="IBM Plex Mono$suffix (TrueType)"
  (cd / && "$powershell" -NoProfile -NonInteractive -Command \
    "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name '$name' -Value '$(wslpath -w "$fonts/IBMPlexMono-$style.ttf")' -PropertyType String -Force | Out-Null")
done
echo "installed IBM Plex Mono for the current Windows user"

# 2. Windows Terminal fragment: the VS Code Dark+ terminal palette pr-stats
# was captured in, over the #1e1e1e the TUI paints anyway
fragment_dir="$local_app/Microsoft/Windows Terminal/Fragments/usage-stats"
mkdir -p "$fragment_dir"
distro="${WSL_DISTRO_NAME:-}"
launch="wsl.exe ${distro:+-d $distro }-- bash -lc '$ROOT/bin/usage-stats'"

cat > "$fragment_dir/usage-stats.json" <<JSON
{
  "profiles": [
    {
      "guid": "{6f1d8c1e-2b8a-4b5e-9a4e-7c3f1e5d2a10}",
      "name": "usage-stats",
      "commandline": "${launch//\\/\\\\}",
      "colorScheme": "pr-stats",
      "font": { "face": "IBM Plex Mono", "size": 12, "weight": "normal" },
      "intenseTextStyle": "bold",
      "antialiasingMode": "grayscale",
      "padding": "12, 8, 12, 8",
      "opacity": 100,
      "useAcrylic": false,
      "backgroundImageOpacity": 0,
      "experimental.retroTerminalEffect": false,
      "cursorShape": "bar",
      "tabTitle": "usage-stats",
      "suppressApplicationTitle": true
    }
  ],
  "schemes": [
    {
      "name": "pr-stats",
      "background": "#1E1E1E",
      "foreground": "#CCCCCC",
      "cursorColor": "#FFFFFF",
      "selectionBackground": "#264F78",
      "black": "#000000",
      "red": "#CD3131",
      "green": "#0DBC79",
      "yellow": "#E5E510",
      "blue": "#2472C8",
      "purple": "#BC3FBC",
      "cyan": "#11A8CD",
      "white": "#E5E5E5",
      "brightBlack": "#666666",
      "brightRed": "#F14C4C",
      "brightGreen": "#23D18B",
      "brightYellow": "#F5F543",
      "brightBlue": "#3B8EEA",
      "brightPurple": "#D670D6",
      "brightCyan": "#29B8DB",
      "brightWhite": "#E5E5E5"
    }
  ]
}
JSON
echo "added the usage-stats profile for the current Windows user"
echo "restart Windows Terminal once so it loads the font and the profile"
echo "open a full-width tab with: usage-stats --wt-tab"
