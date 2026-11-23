"""Zet de Nederlandse vertaling als derde argument achter elke t()/tr!()/T() (na extract.py + translate.py)."""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
QUOTE = {"s": '"', "raw": '"', "q": "'", "d": '"', "b": "`"}


def escape(text, q):
    # Onge-escapete aanhalingstekens van het literal-type escapen; nieuwe regels als \n.
    text = re.sub(r'(?<!\\)((?:\\\\)*)' + re.escape(q), lambda m: m.group(1) + "\\" + q, text)
    return text.replace("\n", "\\n")


def main():
    pairs = json.loads((ROOT / "i18n-tools/pairs.json").read_text())
    nl = json.loads((ROOT / "i18n-tools/nl.json").read_text())
    by_file = {}
    for p in pairs:
        by_file.setdefault(p["file"], []).append(p)
    missing = 0
    for name, ps in by_file.items():
        f = ROOT / name
        text = f.read_text()
        for p in sorted(ps, key=lambda p: -p["end"]):
            k = f'{p["en_kind"]}\t{p["en"]}'
            q = QUOTE[p["en_kind"]]
            if k in nl:
                lit = q + escape(nl[k], q) + q
            else:
                missing += 1
                lit = q + p["en"] + q  # Engels als terugval
            if p["en_kind"] == "raw":
                lit = '"' + escape(nl.get(k, p["en"]).replace("\\", "\\\\"), '"') + '"'
            text = text[:p["end"]] + ", " + lit + text[p["end"]:]
        f.write_text(text)
    print(len(pairs), "ingevoegd,", missing, "zonder vertaling", file=sys.stderr)


if __name__ == "__main__":
    main()
