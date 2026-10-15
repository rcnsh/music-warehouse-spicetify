#!/usr/bin/env bash
# Links the app into Spicetify's CustomApps folder, enables it and applies.
# A symlink rather than a copy, so `spicetify apply` picks up edits here.
# bash on macOS or Linux; on Windows, see "Manual install" in the README.
set -euo pipefail

fail() {
	printf 'install.sh: %s\n' "$1" >&2
	exit 1
}

command -v spicetify >/dev/null 2>&1 ||
	fail "spicetify isn't on your PATH. Install it first: https://spicetify.app/docs/getting-started"

# `spicetify apply` needs a backup of the client to patch. Spicetify records
# the backed-up client version under [Backup] in its config file.
config="$(spicetify -c 2>/dev/null)" || fail "couldn't find Spicetify's config file (spicetify -c failed)."
backup_version="$(awk -F '=' '
	/^\[/ { section = $0; next }
	section == "[Backup]" && $1 ~ /^[[:space:]]*version[[:space:]]*$/ { gsub(/[[:space:]]/, "", $2); print $2 }
' "$config" 2>/dev/null || true)"
[[ -n "$backup_version" ]] ||
	fail "Spicetify has no backup of the Spotify client yet. Run 'spicetify backup apply' once, then run this again."

app_dir="$(cd "$(dirname "$0")/warehouse" && pwd)"
userdata="$(spicetify path userdata 2>/dev/null)" || fail "couldn't find Spicetify's userdata folder (spicetify path userdata failed)."
custom_apps="$userdata/CustomApps"

mkdir -p "$custom_apps"
if [[ -e "$custom_apps/warehouse" && ! -L "$custom_apps/warehouse" ]]; then
	fail "$custom_apps/warehouse exists and isn't a symlink (a copied install?). Remove it, then run this again."
fi
ln -sfn "$app_dir" "$custom_apps/warehouse"

# Add warehouse to custom_apps only if it isn't there, leaving the others
# (marketplace and so on) as they are. `spicetify config custom_apps` prints
# one app per line.
if spicetify config custom_apps | grep -qx 'warehouse'; then
	echo "warehouse is already in custom_apps."
else
	spicetify config custom_apps warehouse
fi

spicetify apply
