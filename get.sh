#!/usr/bin/env bash
# One-line installer for VertiGrid - downloads the latest pre-built release zip and installs it directly.
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
    #  Write UUID directly so the next Shell start picks it up.
    if command -v gsettings >/dev/null && command -v python3 >/dev/null; then
        python3 - "$UUID" <<'PY'
import subprocess, sys, ast

def get_strv(key):
    out = subprocess.run(
        ["gsettings", "get", "org.gnome.shell", key],
        capture_output=True, text=True).stdout.strip()
    try:
        return ast.literal_eval(out) if out and out != "@as []" else []
    except (ValueError, SyntaxError):
        return []

def set_strv(key, items):
    subprocess.run(
        ["gsettings", "set", "org.gnome.shell", key,
         "[" + ", ".join("'%s'" % i for i in items) + "]"],
        check=True)

uuid = sys.argv[1]

disabled = get_strv("disabled-extensions")
if uuid in disabled:
    set_strv("disabled-extensions", [i for i in disabled if i != uuid])

enabled = get_strv("enabled-extensions")
if uuid not in enabled:
    enabled.append(uuid)
    set_strv("enabled-extensions", enabled)
PY
        echo ":: Registered in enabled-extensions. Log out and back in to see it."
    else
        echo ":: Installed, but couldn't enable it yet - GNOME Shell may not have"
        echo "   noticed the new extension. Log out and back in, then run:"
        echo "     gnome-extensions enable $UUID"
    fi
fi
