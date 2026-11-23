#!/usr/bin/env bash
# Eenmalig, met sudo: Bonnetje rechtstreeks naar de Star TSP100 laten printen (zonder emupos-brug).
#   sudo bash ~/Code/Bonnetje/scripts/pi-star.sh
# Terugdraaien: PRINTR_PROTOCOL/PRINTR_DEVICE weg, PRINTR_TCP=127.0.0.1:9100 terug,
#   systemctl enable --now printr-star && systemctl restart printr
set -euo pipefail
ENV=/etc/printr.env
set_env() { if grep -q "^$1=" $ENV; then sed -i "s|^$1=.*|$1=$2|" $ENV; else echo "$1=$2" >> $ENV; fi; }
sed -i 's|^PRINTR_TCP=|#PRINTR_TCP=|' $ENV
set_env PRINTR_DEVICE /dev/usb/lp0
set_env PRINTR_PROTOCOL star
systemctl disable --now printr-star
systemctl restart printr
sleep 2
systemctl is-active printr
journalctl -u printr -o cat -n 12 | grep -E "printer|claude|versions"
