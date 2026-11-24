#!/usr/bin/env bash
# Eenmalig, met sudo: oude emupos-brug en Claude-vertaaldienst verwijderen, MOTD bijwerken.
#   sudo bash ~/Code/Bonnetje/scripts/pi-opruimen.sh
set -euo pipefail
for u in printr-star printr-claude; do
  systemctl disable --now "$u" 2>/dev/null || true
  rm -f "/etc/systemd/system/$u.service"
done
systemctl daemon-reload
systemctl reset-failed printr-star printr-claude 2>/dev/null || true
rm -rf /opt/printr-star /opt/printr-claude
bash "/home/${SUDO_USER:-olivier}/dotfiles/pi/install.sh"
systemctl is-active printr
