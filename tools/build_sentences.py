"""Build data/sentences.json from tools/sentences/*.txt and validate them against data/words.json.

Source format (one sentence per line):
    norsk | français | english

Markup inside the Norwegian text:
    *Anna          proper name (not checked, not in the word list)
    [i går]        multi-word expression from the word list (e.g. essentials)
    tre{tre_num}   force the word id when a form is ambiguous

Directives:
    @theme <key> <Label>   theme of the following sentences
    @level <300|600|1000>  intended level; a warning is printed if a sentence needs more

Every word must be a known form. The sentence level is the lowest level L such that at most
EXTRA_RATIO of its words are above L; those words are flagged "x" (shown as bonus words).
Exit code 1 if any sentence contains an unknown word.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "sentences"
WORDS = ROOT / "data" / "words.json"
OUT = ROOT / "data" / "sentences.json"
TARGET_PER_WORD = 5
EXTRA_RATIO = 0.20  # share of words allowed above the sentence level

TOKEN_RE = re.compile(
    r"\[(?P<expr>[^\]]+)\](?:\{(?P<eid>[^}]+)\})?"
    r"|(?P<name>\*[\wæøåÆØÅéÉ-]+)"
    r"|(?P<word>[\wæøåÆØÅéÉ]+(?:-[\wæøåÆØÅéÉ]+)*)(?:\{(?P<wid>[^}]+)\})?"
    r"|(?P<other>[^\w\s\[\]*]+|\s+)"
)

FUNCTION_POS = {"konj", "prep", "pron", "det", "adv", "int", "inf"}
SUBJECTS = {"jeg", "du", "han", "hun", "vi", "dere", "de", "man", "det", "den", "som", "hvem", "hva"}
DETERMINERS = {"en", "ei", "et", "min", "mi", "mitt", "mine", "din", "di", "ditt", "dine", "hans", "hennes",
               "vår", "vårt", "våre", "deres", "sin", "si", "sitt", "sine", "denne",
               "dette", "disse", "mange", "noen", "alle", "hver", "hvert", "to", "tre", "fire", "fem", "ingen",
               "flere", "en{en_num}"}


def load_words():
    words = json.loads(WORDS.read_text(encoding="utf-8"))
    by_id = {w["id"]: w for w in words}
    index = {}
    for w in words:
        for v in w["variants"]:
            index.setdefault(v, []).append(w)
    return by_id, index


def finite(w, tok_lower):
    f = w.get("forms", {})
    return any(tok_lower in f.get(k, "").split("/") for k in ("pres", "past"))


def score(w, tok_lower, prev, nxt):
    """Lower is better."""
    # lower level first: a form shared by a level-300 word and a level-2000 word goes to the level-300 one
    s = (w.get("rank", 0) if w["list"] in ("core", "core2") else 5000) + w["level"] * 100  # 300→30k … 2000→200k: a level-2000 lemma loses to a lower-level form, but a level-600 lemma still beats a level-300 form
    if w["lemma"].lower() == tok_lower:
        # function words (når, så, for...) win over a verb/noun form with the same spelling
        s -= 300000 if w["pos"] in FUNCTION_POS else 100000
    if (prev in SUBJECTS or nxt in SUBJECTS) and w["pos"] == "verb" and finite(w, tok_lower):
        s -= 200000
    if prev in DETERMINERS and w["pos"] in ("noun", "adj"):
        s -= 200000
    return s


def resolve(tok, forced, index, by_id, prev, nxt):
    low = tok.lower()
    if forced:
        if forced not in by_id:
            return None, f"unknown id {{{forced}}}"
        if low not in by_id[forced]["variants"]:
            return None, f"'{tok}' is not a form of {forced}"
        return by_id[forced], None
    cands = index.get(low, [])
    if not cands:
        return None, f"unknown word '{tok}'"
    cands = sorted(cands, key=lambda w: score(w, low, prev, nxt))
    return cands[0], (None if len({c["id"] for c in cands}) == 1 else "ambiguous")


def sentence_level(levels):
    for lv in (300, 600, 1000, 2000):
        above = sum(1 for x in levels if x > lv)
        if above <= EXTRA_RATIO * len(levels):
            return lv
    return 2000


def parse_line(line, index, by_id):
    tokens, errors, ambig = [], [], []
    prev = None
    matches = list(TOKEN_RE.finditer(line))
    word_texts = [(i, (m.group("word") or "").lower()) for i, m in enumerate(matches) if m.group("word")]
    next_word = {}
    for (i, _), (_, t) in zip(word_texts, word_texts[1:]):
        next_word[i] = t
    for i, m in enumerate(matches):
        if m.group("expr"):
            text = m.group("expr").strip()
            eid = m.group("eid")
            w = by_id.get(eid) if eid else next(
                (x for x in index.get(text.lower(), []) if x["lemma"].lower() == text.lower()), None)
            if w and text.lower() not in w["variants"] and not eid:
                w = None
            if not w:
                errors.append(f"unknown expression [{text}]")
                tokens.append({"t": text})
            else:
                tokens.append({"t": text, "w": w["id"]})
            prev = text.split()[-1].lower()
        elif m.group("name"):
            tokens.append({"t": m.group("name")[1:], "name": True})
            prev = None
        elif m.group("word"):
            text = m.group("word")
            w, err = resolve(text, m.group("wid"), index, by_id, prev, next_word.get(i))
            if w is None:
                errors.append(err)
                tokens.append({"t": text})
            else:
                tokens.append({"t": text, "w": w["id"]})
                if err == "ambiguous":
                    ambig.append(f"{text}→{w['id']}")
            prev = text.lower()
        else:
            tokens.append({"t": m.group("other")})
    return tokens, errors, ambig


def multiword_patterns(by_id):
    """[(regex, id)] for every multi-word variant, longest first, so 'gå glipp av' is found as one token."""
    pats = []
    for w in by_id.values():
        for v in w["variants"]:
            if " " in v:
                pats.append((re.compile(r"(?<![\w\[])" + r"\s+".join(map(re.escape, v.split())) + r"(?![\w\]{])",
                                        re.IGNORECASE), v, w["id"]))
    pats.sort(key=lambda x: -len(x[1]))
    return pats


def bracket_multiwords(line, pats):
    """Wrap plain multi-word expressions as [expr]{id}; text already in [...] is left alone."""
    for rx, _, wid in pats:
        line = rx.sub(lambda m: f"[{m.group(0)}]{{{wid}}}", line)
    return line


def main():
    verbose = "-v" in sys.argv
    by_id, index = load_words()
    pats = multiword_patterns(by_id)
    out, n_err, seen = [], 0, set()
    for path in sorted(SRC.glob("*.txt")):
        theme, label, target = None, None, None
        for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if line.startswith("@theme"):
                parts = line.split(maxsplit=2)
                theme, label = parts[1], parts[2] if len(parts) > 2 else parts[1]
                continue
            if line.startswith("@level"):
                target = int(line.split()[1])
                continue
            fields = [f.strip() for f in line.split("|")]
            if len(fields) != 3:
                print(f"{path.name}:{n}: need 3 fields: {raw}")
                n_err += 1
                continue
            no_src, fr, en = fields
            if path.name.startswith("9"):  # level-2000 files: phrasal verbs are matched automatically
                no_src = bracket_multiwords(no_src, pats)
            tokens, errors, ambig = parse_line(no_src, index, by_id)
            no = "".join(t["t"] for t in tokens)
            if errors:
                n_err += 1
                print(f"{path.name}:{n}: {no}\n    " + "; ".join(errors))
                continue
            levels = [by_id[t["w"]]["level"] for t in tokens if t.get("w")]
            level = sentence_level(levels)
            for t in tokens:
                if t.get("w") and by_id[t["w"]]["level"] > level:
                    t["x"] = True
            sid = "s_" + hashlib.md5(no.encode("utf-8")).hexdigest()[:8]
            if sid in seen:
                print(f"{path.name}:{n}: duplicate sentence: {no}")
                continue
            seen.add(sid)
            if verbose and target and level > target:
                hard = [f"{t['t']}({by_id[t['w']]['level']})" for t in tokens
                        if t.get("w") and by_id[t["w"]]["level"] > target]
                print(f"{path.name}:{n}: level {level} > {target}: {no}  <- {', '.join(hard)}")
            if verbose and ambig:
                print(f"{path.name}:{n}: {no}  ~ {', '.join(ambig)}")
            out.append({"id": sid, "no": no, "fr": fr, "en": en, "level": level,
                        "theme": theme, "themeLabel": label, "tokens": tokens})
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    used = {}  # word id -> number of sentences containing it that are visible at the word's own level
    for s in out:
        for wid in {tok["w"] for tok in s["tokens"] if tok.get("w")}:
            if s["level"] <= by_id[wid]["level"]:
                used[wid] = used.get(wid, 0) + 1
    words = sorted(by_id.values(), key=lambda w: (w["list"] not in ("core", "core2"), w.get("rank", 0)))
    groups = [(f"niveau {lv}", [w for w in words if w["list"] in ("core", "core2") and w["level"] == lv])
              for lv in (300, 600, 1000, 2000)]
    groups.append(("essentiels", [w for w in words if w["list"] == "essentials"]))
    groups.append(("métier/vie locale", [w for w in words if w["list"] == "theme"]))
    print(f"\nCouverture (objectif : {TARGET_PER_WORD} phrases par mot) :")
    for name, ws in groups:
        n1 = sum(1 for w in ws if used.get(w["id"], 0) >= 1)
        nt = sum(1 for w in ws if used.get(w["id"], 0) >= TARGET_PER_WORD)
        print(f"  {name}: au moins 1 phrase {n1}/{len(ws)} · au moins {TARGET_PER_WORD} : {nt}/{len(ws)}")
        if "--missing" in sys.argv:
            short = [f"{w['id']}({used.get(w['id'], 0)})" for w in ws if used.get(w["id"], 0) < TARGET_PER_WORD]
            if short:
                print("    à compléter: " + ", ".join(short))
    counts = {lv: sum(1 for s in out if s["level"] == lv) for lv in (300, 600, 1000, 2000)}
    print(f"{len(out)} sentences written  (300: {counts[300]}, 600: {counts[600]}, 1000: {counts[1000]}, 2000: {counts[2000]})"
          f"  errors: {n_err}")
    sys.exit(1 if n_err else 0)


if __name__ == "__main__":
    main()
