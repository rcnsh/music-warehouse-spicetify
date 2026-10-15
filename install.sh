#!/usr/bin/env bash
# Links the app into Spicetify's CustomApps folder, enables it and applies.
# A symlink rather than a copy, so `spicetify apply` picks up edits here.
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/warehouse" && pwd)"
custom_apps="$(spicetify path userdata)/CustomApps"

mkdir -p "$custom_apps"
ln -sfn "$app_dir" "$custom_apps/warehouse"
spicetify config custom_apps warehouse
spicetify apply
