#!/usr/bin/env bash
# Eenmalig, met sudo: Bonnetje in het Nederlands, zonder de Claude-vertaaldienst.
#   sudo bash ~/Code/Bonnetje/scripts/pi-nederlands.sh [pad/naar/barnum-nl.py]
# - PRINTR_LANG=nl
# - Claude rechtstreeks via de CLI (kruiswoorddefinities ook): printr-claude-dienst uit, nep-API-variabelen weg
# - Barnum: Nederlandse taalmodule (lokaal; Barnum zelf heeft geen licentie om te herverdelen)
# - CrossWords-cache: Engelse lijst terug, Nederlandse definities naar definitions-nl.txt
set -euo pipefail
ENV=/etc/printr.env
set_env() { if grep -q "^$1=" $ENV; then sed -i "s|^$1=.*|$1=$2|" $ENV; else echo "$1=$2" >> $ENV; fi; }
set_env PRINTR_LANG nl
set_env PRINTR_CLAUDE_CLI /usr/local/bin/claude
set_env PRINTR_CLAUDE_MODEL claude-sonnet-5-5
sed -i -e 's|^ANTHROPIC_BASE_URL=|#ANTHROPIC_BASE_URL=|' -e 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=|' $ENV
systemctl disable --now printr-claude 2>/dev/null || true

NLPY=${1:-/home/${SUDO_USER:-olivier}/.local/share/bonnetje/barnum-nl.py}
if [ -f "$NLPY" ] && [ -d /opt/barnum/barnum/langues ]; then
  install -m 644 "$NLPY" /opt/barnum/barnum/langues/nl.py
  sed -i -e 's/^from \. import en, fr$/from . import en, fr, nl/' \
         -e 's/(fr\.LANGUE, en\.LANGUE)/(fr.LANGUE, en.LANGUE, nl.LANGUE)/' /opt/barnum/barnum/langues/__init__.py
fi

C=/var/cache/printr/crosswords
if [ -f $C/en-v1.txt.english ]; then mv -f $C/en-v1.txt.english $C/en-v1.txt; fi
if [ -f $C/definitions-en.txt.english ]; then
  [ -f $C/definitions-en.txt ] && mv -f $C/definitions-en.txt $C/definitions-nl.txt
  mv -f $C/definitions-en.txt.english $C/definitions-en.txt
fi
rm -f /var/cache/printr/claude/mots-croises-*-en.json /var/cache/printr/claude/arrow-words-*-en.json
chown -R printr:printr $C

systemctl restart printr
sleep 2
systemctl is-active printr
journalctl -u printr -o cat -n 12 | grep -E "printr|claude|barnum|versions"
