"""Vindt alle t("fr", "en") / tr!("fr", "en", ...) in src/ en T('fr', 'en') in web/app.js.

Gebruik: python3 i18n-tools/extract.py  -> i18n-tools/pairs.json (lijst van {file, start, end, fr, en, kind})
`end` is de positie direct na de Engelse literal: daar komt de Nederlandse bij.
"""
import json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUST_LIT = r'(?:r(?P<h{n}>#*)"(?P<raw{n}>.*?)"(?P=h{n})|"(?P<s{n}>(?:[^"\\]|\\.)*)")'
RUST = re.compile(r'(?<![\w.])(?P<kind>t\(|tr!\(|i18n::t\(|crate::i18n::t\()\s*'
                  + RUST_LIT.format(n=1) + r'\s*,\s*' + RUST_LIT.format(n=2), re.S)
JS_LIT = r"""(?:'(?P<q{n}>(?:[^'\\]|\\.)*)'|"(?P<d{n}>(?:[^"\\]|\\.)*)"|`(?P<b{n}>(?:[^`\\]|\\.)*)`)"""
JS = re.compile(r'(?<![\w.$])(?P<kind>T\()\s*' + JS_LIT.format(n=1) + r'\s*,\s*' + JS_LIT.format(n=2), re.S)


def lit(m, n, js):
    if js:
        for k in "qdb":
            if m.group(f"{k}{n}") is not None:
                return m.group(f"{k}{n}"), k
    if m.group(f"raw{n}") is not None:
        return m.group(f"raw{n}"), "raw"
    return m.group(f"s{n}"), "s"


def scan():
    out = []
    files = sorted((ROOT / "src").rglob("*.rs")) + [ROOT / "web/app.js"]
    for f in files:
        js = f.suffix == ".js"
        text = f.read_text()
        for m in (JS if js else RUST).finditer(text):
            fr, fk = lit(m, 1, js)
            en, ek = lit(m, 2, js)
            out.append({"file": str(f.relative_to(ROOT)), "start": m.start(), "end": m.end(),
                        "kind": m.group("kind"), "fr": fr, "en": en, "en_kind": ek})
    return out


if __name__ == "__main__":
    pairs = scan()
    (ROOT / "i18n-tools/pairs.json").write_text(json.dumps(pairs, ensure_ascii=False, indent=1))
    uniq = {p["en"] for p in pairs}
    print(len(pairs), "plaatsen,", len(uniq), "unieke Engelse teksten")
    for kind in sorted({p["kind"] for p in pairs}):
        print(" ", kind, sum(p["kind"] == kind for p in pairs))
