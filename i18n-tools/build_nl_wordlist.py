"""Nederlandse woordenlijst in CrossWords-formaat (woord<TAB>score) uit OpenTaal + ondertitel-frequenties.

Scores volgen de niveaus van CrossWords: >=22 niveau 1, >=17 niveau 2, >=12 niveau 3, >=8 niveau 4.
Gebruik: python3 -I build_nl.py wordlist.txt nl_full.txt > nl.txt
"""
import re, sys

# ponytail: grenzen op frequentierang, ruwweg zoals de Engelse lijst verdeeld is; bijstellen als niveau 1 te moeilijk is
BANDS = [(15000, 22), (30000, 17), (50000, 12), (80000, 8)]
OK = re.compile(r"[a-z]{2,15}")


def score(rank):
    for limit, s in BANDS:
        if rank <= limit:
            return s
    return 0


def build(opentaal_lines, freq_lines):
    valid = {w for w in (l.strip() for l in opentaal_lines) if OK.fullmatch(w)}
    out, rank = {}, 0
    for line in freq_lines:
        w = line.split(" ", 1)[0]
        if w in valid and w not in out:
            rank += 1
            out[w] = score(rank)
    for w in valid:
        out.setdefault(w, 0)
    return out


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as a, open(sys.argv[2], encoding="utf-8") as b:
        words = build(a, b)
    print("# Nederlands: OpenTaal-woordenlijst (BSD/CC-BY) + FrequencyWords (MIT/CC-BY-SA), scores op frequentierang")
    for w in sorted(words):
        print(f"{w}\t{words[w]}")
