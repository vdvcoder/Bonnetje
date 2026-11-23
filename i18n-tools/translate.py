"""Vertaalt de Engelse teksten uit pairs.json naar het Nederlands met de Claude CLI (abonnement).

Gebruik: python3 i18n-tools/translate.py   -> vult i18n-tools/nl.json aan ({sleutel: nl}); herstartbaar.
Sleutel = soort literal + Engelse tekst. Plaatshouders ({x}, {:>3}, ${...}) en escapes blijven gelijk.
"""
import json, pathlib, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "i18n-tools/nl.json"
BATCH = 60

SYSTEM = """You translate UI and receipt strings of a receipt-printer app ("Bonnetje", formerly "Printr") into Dutch (standard Dutch, natural for Flemish/Belgian readers, informal "je").
Rules:
- Translate the ENGLISH text; the French is only context.
- Keep EXACTLY all placeholders and code: {name}, {}, {:?}, {n:>3}, {{, }}, ${...} expressions, %s, HTML tags, emoji, symbols.
- Keep backslash escapes exactly as written (\\n, \\", \\', \\u{...}).
- Keep it as short as the English where possible (narrow thermal receipts, 42 characters per line).
- Replace the product name "Printr" by "Bonnetje". Keep other proper names, env var names (PRINTR_...), file paths, units.
- Keep leading/trailing spaces and punctuation style. Same capitalization style as the English.
- If a string is not natural language (a code, a single symbol), return it unchanged."""

SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object",
          "properties": {"id": {"type": "integer"}, "nl": {"type": "string"}}, "required": ["id", "nl"],
          "additionalProperties": False}}}, "required": ["items"], "additionalProperties": False}

PH = re.compile(r"\$\{[^}]*\}|\{\{|\}\}|\{[^{}]*\}")


def key(p):
    return f'{p["en_kind"]}\t{p["en"]}'


def ok(en, nl):
    return sorted(PH.findall(en)) == sorted(PH.findall(nl))


def batch(items):
    prompt = "Translate each item. Return all ids.\n\n" + json.dumps(
        [{"id": i, "en": p["en"], "fr": p["fr"], "file": p["file"]} for i, p in items], ensure_ascii=False)
    r = subprocess.run(["claude", "-p", "--output-format", "json", "--no-session-persistence", "--tools", "",
                        "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
                        "--model=claude-sonnet-5-5", f"--json-schema={json.dumps(SCHEMA)}",
                        f"--system-prompt={SYSTEM}"], input=prompt, capture_output=True, text=True, timeout=600)
    out = json.loads(r.stdout).get("structured_output") or {}
    return {i["id"]: i["nl"] for i in out.get("items", [])}


def main():
    pairs = json.loads((ROOT / "i18n-tools/pairs.json").read_text())
    done = json.loads(OUT.read_text()) if OUT.exists() else {}
    todo = {}
    for p in pairs:
        if key(p) not in done:
            todo.setdefault(key(p), p)
    todo = list(todo.items())
    print(len(todo), "te vertalen", file=sys.stderr)
    chunks = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]

    def run(chunk):
        try:
            return chunk, batch([(n, p) for n, (_, p) in enumerate(chunk)])
        except Exception as e:  # batch later opnieuw
            print("batch mislukt:", e, file=sys.stderr)
            return chunk, {}

    with ThreadPoolExecutor(4) as pool:
        for chunk, got in pool.map(run, chunks):
            for n, (k, p) in enumerate(chunk):
                nl = got.get(n)
                if nl is not None and ok(p["en"], nl):
                    done[k] = nl
                elif nl is not None:
                    print("plaatshouders wijken af:", p["en"], "=>", nl, file=sys.stderr)
            OUT.write_text(json.dumps(done, ensure_ascii=False, indent=1, sort_keys=True))
            print(len(done), "klaar", file=sys.stderr)


if __name__ == "__main__":
    main()
