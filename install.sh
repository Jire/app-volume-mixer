#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# Installs (or updates) App Volume Mixer for the current user and enables it.
#
#   curl -fsSL https://raw.githubusercontent.com/Jire/app-volume-mixer/main/install.sh | bash
#   wget -qO-  https://raw.githubusercontent.com/Jire/app-volume-mixer/main/install.sh | bash
#
# Run from a clone of the repository, it installs the local source instead of
# downloading. Pass --uninstall to remove the extension.
set -euo pipefail

UUID=app-volume-mixer@jire.github.io
REPO=Jire/app-volume-mixer
RELEASE_ZIP_URL="https://github.com/$REPO/releases/latest/download/$UUID.shell-extension.zip"
SOURCE_TARBALL_URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"

info() { printf '\033[1;34m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] && die "run this as your normal user, not root (extensions are installed per user)."
command -v gnome-extensions >/dev/null || die "gnome-extensions not found. This extension needs the GNOME desktop (GNOME Shell 46 or newer)."

if [[ ${1:-} == --uninstall ]]; then
    dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
    # The D-Bus uninstall fails if the shell hasn't loaded it yet (installed
    # but not logged out yet), so fall back to removing the files directly.
    gnome-extensions uninstall "$UUID" 2>/dev/null || {
        [[ -d $dir ]] || die "$UUID is not installed."
        rm -rf "$dir"
    }
    enabled=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ $enabled == *"'$UUID'"* ]]; then
        gsettings set org.gnome.shell enabled-extensions \
            "$(sed -E "s/'$UUID'(, )?//; s/, \]/]/" <<<"$enabled")"
    fi
    info "Uninstalled $UUID. Log out and back in to finish removing it from the running session."
    exit 0
fi

fetch() { # fetch URL FILE
    if command -v curl >/dev/null; then
        curl -fsSL --retry 2 -o "$2" "$1"
    elif command -v wget >/dev/null; then
        wget -q -O "$2" "$1"
    else
        die "need curl or wget to download the extension."
    fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/$UUID.shell-extension.zip"

# When piped into bash there is no script file, so this only matches a checkout.
script_dir=
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then
    script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi
if [[ -n $script_dir ]] && grep -qs "\"$UUID\"" "$script_dir/src/metadata.json"; then
    info "Packing local source from $script_dir/src"
    gnome-extensions pack --force --out-dir="$tmp" "$script_dir/src" >/dev/null
elif fetch "$RELEASE_ZIP_URL" "$zip" 2>/dev/null; then
    info "Downloaded the latest release"
else
    info "No release found, installing from the main branch"
    fetch "$SOURCE_TARBALL_URL" "$tmp/src.tar.gz" ||
        die "could not download from github.com/$REPO. Check your internet connection."
    tar -xzf "$tmp/src.tar.gz" -C "$tmp"
    gnome-extensions pack --force --out-dir="$tmp" "$tmp"/app-volume-mixer-main/src >/dev/null
fi
[[ -f $zip ]] || die "failed to build or download the extension package."

# Warn (but continue) if this GNOME version isn't one we declare support for.
shell_major=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
if [[ -n $shell_major ]]; then
    supported=$(unzip -p "$zip" metadata.json 2>/dev/null || true)
    if [[ -n $supported && $supported != *"\"$shell_major\""* ]]; then
        warn "GNOME Shell $shell_major is not in this extension's supported versions; GNOME may refuse to load it."
    fi
fi

gnome-extensions install --force "$zip"
info "Installed $UUID"

# On Wayland the running shell doesn't see newly installed extensions until
# the next login, so `gnome-extensions enable` fails for a first install.
# Writing the setting directly makes it load at the next login instead.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    enabled=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ $enabled != *"'$UUID'"* ]]; then
        if [[ $enabled == "@as []" || $enabled == "[]" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['$UUID']"
        else
            gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$UUID']"
        fi
    fi
    disabled=$(gsettings get org.gnome.shell disabled-extensions 2>/dev/null || echo "[]")
    if [[ $disabled == *"'$UUID'"* ]]; then
        cleaned=$(sed -E "s/'$UUID'(, )?//; s/, \]/]/" <<<"$disabled")
        gsettings set org.gnome.shell disabled-extensions "$cleaned"
    fi
    needs_relogin=1
fi

if [[ $(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null) == true ]]; then
    warn "user extensions are switched off. Turn them on in the Extensions app (or run: gsettings set org.gnome.shell disable-user-extensions false)."
fi

if [[ ${needs_relogin:-} ]]; then
    info "Done. Log out and back in to start it (GNOME only picks up new extensions at login)."
else
    info "Done. It's enabled; if you updated an existing install, log out and back in to load the new version."
fi
info "Open Quick Settings and click the arrow next to the volume slider."
