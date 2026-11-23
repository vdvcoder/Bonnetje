"""Maakt naast elke `const X_EN: ... = [...];` een `X_NL` met vertaalde tekst (Claude CLI).

Gebruik: python3 i18n-tools/arrays.py vertaal   -> i18n-tools/arrays-nl.json
         python3 i18n-tools/arrays.py schrijf   -> voegt de X_NL-constanten in src/ toe
"""
import json, pathlib, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "i18n-tools/arrays-nl.json"
DECL = re.compile(r'^(?P<indent>[ \t]*)(?:#\[rustfmt::skip\]\n[ \t]*)?(?P<head>(?:pub )?(?:const|static) (?P<name>[A-Z_]*EN)\s*:[^=]*=\s*)(?P<body>&?\[.*?\n(?P=indent)\];)', re.M | re.S)
STR = re.compile(r'"((?:[^"\\]|\\.)*)"')
SKIP = {"DAYS_EN", "MONTHS_EN", "LETTERS_EN"}  # handmatig / niet te vertalen

SYSTEM = """You translate content lists of a receipt-printer app into Dutch (standard Dutch, natural for Flemish/Belgian readers, informal "je").
Each item is one string literal from a Rust array; the array name and neighbouring items give context.
Rules: keep backslash escapes and placeholders exactly; keep proper names (people, authors) unchanged; translate famous quotes with their usual Dutch rendering or a faithful translation;
riddles/jokes/wordplay: adapt so they still work in Dutch (question and answer must match each other — adapt both consistently);
workout exercises: common Dutch fitness terms; keep numbers; keep it short (42-character receipt lines).
Do not use the double-quote character inside translations (use ‘ ’ or « » instead)."""

SCHEMA = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object",
          "properties": {"id": {"type": "integer"}, "nl": {"type": "string"}}, "required": ["id", "nl"],
          "additionalProperties": False}}}, "required": ["items"], "additionalProperties": False}


def decls():
    for f in sorted((ROOT / "src").rglob("*.rs")):
        text = f.read_text()
        for m in DECL.finditer(text):
            if m.group("name") not in SKIP:
                yield f, m


def claude(items, name):
    prompt = f"Array {name}. Translate every item, return all ids.\n\n" + json.dumps(items, ensure_ascii=False)
    r = subprocess.run(["claude", "-p", "--output-format", "json", "--no-session-persistence", "--tools", "",
                        "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
                        "--model=claude-sonnet-5-5", f"--json-schema={json.dumps(SCHEMA)}",
                        f"--system-prompt={SYSTEM}"], input=prompt, capture_output=True, text=True, timeout=900)
    out = json.loads(r.stdout).get("structured_output") or {}
    return {i["id"]: i["nl"] for i in out.get("items", [])}


def translate():
    done = json.loads(OUT.read_text()) if OUT.exists() else {}
    jobs = []
    for f, m in decls():
        k = f"{f.relative_to(ROOT)}:{m.group('name')}"
        if k in done:
            continue
        strings = STR.findall(m.group("body"))
        jobs.append((k, m.group("name"), strings))

    def run(job):
        k, name, strings = job
        got = {}
        for i in range(0, len(strings), 80):
            part = [{"id": j, "en": s} for j, s in enumerate(strings) if i <= j < i + 80]
            got.update(claude(part, name))
        return k, [got.get(j, s).replace('"', "'") for j, s in enumerate(strings)], len(got) == len(strings)

    with ThreadPoolExecutor(4) as pool:
        for k, nl, complete in pool.map(run, jobs):
            if complete:
                done[k] = nl
            print(k, "ok" if complete else "ONVOLLEDIG", file=sys.stderr)
            OUT.write_text(json.dumps(done, ensure_ascii=False, indent=1))


def write():
    done = json.loads(OUT.read_text())
    for f in sorted((ROOT / "src").rglob("*.rs")):
        text = f.read_text()
        for m in reversed(list(DECL.finditer(text))):
            k = f"{f.relative_to(ROOT)}:{m.group('name')}"
            if k not in done or re.search(rf"(const|static) {m.group('name')[:-2]}NL\b", text):
                continue
            it = iter(done[k])
            body = STR.sub(lambda _: '"' + next(it) + '"', m.group("body"))
            new = "\n" + m.group("indent") + "#[rustfmt::skip]\n" + m.group("indent") + m.group("head").replace(m.group("name"), m.group("name")[:-2] + "NL", 1) + body
            text = text[:m.end()] + new + text[m.end():]
        f.write_text(text)


if __name__ == "__main__":
    {"vertaal": translate, "schrijf": write}[sys.argv[1]]()
