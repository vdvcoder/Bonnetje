# Eigen blokken

Een eigen blok is een uitvoerbaar script in `/opt/bonnetje/blokken` (of `PRINTR_BLOCKS_DIR`).
In de app kies je het via **Eigen blok**; de keuzelijst toont alle scripts uit die map.

Het script:

- heeft een naam van kleine letters, cijfers, `-` of `_` en is uitvoerbaar (`chmod +x`);
- krijgt `BONNETJE_LANG` (`nl`), `BONNETJE_DATE` (`2026-11-24`) en `BONNETJE_CITY` (de stad uit de instellingen) mee;
- print op stdout een JSON-lijst met gewone blokken, bijvoorbeeld:

```json
[
  {"type": "title", "text": "Hallo"},
  {"type": "text", "text": "Een eigen blok.", "align": "center"},
  {"type": "separator"},
  {"type": "qr", "data": "https://github.com/vdvcoder/Bonnetje"}
]
```

- bepaalt zelf de witruimte (`{"type": "feed", "lines": 1}`, `separator`);
- stopt met exitcode 0 (anders wordt de laatste regel van stderr getoond) en is binnen 180 s klaar.

Het draait als gebruiker `printr`, zonder toegang tot `/home`, behalve wat een drop-in toelaat
(zie `scripts/pi-blokken.sh` voor healthstatus). Een eigen blok in een eigen blok kan niet.

Snel een idee testen: `BONNETJE_LANG=nl ./mijnblok | python3 -m json.tool`.
