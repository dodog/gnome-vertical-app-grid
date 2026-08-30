#!/usr/bin/env bash
# One-line installer for VertiGrid - downloads the latest pre-built release
# zip (already has compiled translations) and installs it directly.
#
#   curl -fsSL https://raw.githubusercontent.com/dodog/vertigrid/main/get.sh | bash
set -euo pipefail

UUID="vertigrid@dodog.github.com"
URL="https://github.com/dodog/vertigrid/releases/latest/download/$UUID.zip"

if ! command -v gnome-extensions >/dev/null; then
    echo "get: 'gnome-extensions' not found (not a GNOME desktop?)" >&2
    exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
ZIP="$TMPDIR/$UUID.zip"

echo ":: Downloading VertiGrid..."
curl -fsSL "$URL" -o "$ZIP"

echo ":: Installing extension..."
gnome-extensions install -f "$ZIP"

echo ":: Enabling extension..."
if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo ":: Enabled. Open the app grid to see it."
else
    echo ":: Installed, but couldn't enable it yet - GNOME Shell may not have"
    echo "   noticed the new extension. Log out and back in, then run:"
    echo "     gnome-extensions enable $UUID"
fi
