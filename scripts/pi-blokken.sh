#!/usr/bin/env bash
# Met sudo (opnieuw draaien mag): map voor eigen blokken, schrijfbaar vanuit de app, + healthstatus.
#   sudo bash ~/Code/Bonnetje/scripts/pi-blokken.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
U=${SUDO_USER:-olivier}
H=$(getent passwd "$U" | cut -d: -f6)
DIR=/opt/bonnetje/blokken

# Map: schrijfbaar voor jou (en de groep printr), leesbaar voor Bonnetje.
install -d -m 755 /opt/bonnetje
install -d -o "$U" -g printr -m 2775 "$DIR"
for f in "$HERE"/blokken/*; do
  case "$(basename "$f")" in *.md) continue ;; esac
  [ -e "$DIR/$(basename "$f")" ] || install -o "$U" -g printr -m 775 "$f" "$DIR/"
done

# healthstatus mag zijn code lezen en de Garmin-tokens bijwerken; de rest van /home blijft dicht.
install -d /etc/systemd/system/printr.service.d
cat > /etc/systemd/system/printr.service.d/bonnetje-blokken.conf <<CONF
[Service]
# Eigen blokken bewaren vanuit de app.
ReadWritePaths=$DIR
ProtectHome=tmpfs
BindReadOnlyPaths=$H/Code/healthstatus
BindPaths=$H/.garminconnect
CONF
systemctl daemon-reload
systemctl restart printr
sleep 2
systemctl is-active printr
ls -l "$DIR"
