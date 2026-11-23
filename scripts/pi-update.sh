#!/usr/bin/env bash
# Bonnetje bijwerken op de Pi: ophalen, compileren en de draaiende installatie vervangen.
#   bash ~/Code/Bonnetje/scripts/pi-update.sh
# De binary staat (nog) als /opt/printr/printr; die map is schrijfbaar voor de groep printr.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
~/.cargo/bin/cargo build --release
[ -f /opt/printr/printr.upstream ] || cp -p /opt/printr/printr /opt/printr/printr.upstream
cp target/release/printr /opt/printr/printr.new && mv /opt/printr/printr.new /opt/printr/printr
echo "Geïnstalleerd: $(/opt/printr/printr --version). Herstart met: sudo systemctl restart printr"
