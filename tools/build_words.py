"""Build data/words.json from tools/lexicon/*.txt + frequency list.

Lexicon line format (fields separated by '|', trailing fields optional):
    lemma | pos | fr | en | forms | flags

pos:
    m, f, n      noun (masc / fem / neuter)       forms: indef, def, pl, defpl
    npl          plural-only noun                 forms: pl, defpl
    npl-m/f/n    plural-only noun with its gender (penger npl-m, klær npl-n)
    v1           kaste  -> kaster, kasta/kastet, kasta/kastet
    v2           spise  -> spiser, spiste, spist
    v3           prøve  -> prøver, prøvde, prøvd   (bo -> bor, bodde, bodd)
    v            irregular verb                   forms: inf, pres, past, perf
    adj          adjective                        forms: base, neuter, plural, comp, sup
    adv pron det prep konj int num expr           forms: any extra forms
In a forms slot, '/' separates variants (first = preferred for display).
Empty slots in explicit forms fall back to the rule-generated value.

flags (space separated):
    freq=a,b,c   count only these forms for frequency (homograph protection)

Directives:
    @list core|essentials   which list following lines belong to
    @group <name>           sub-group label (essentials: numbers, days, ...)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEX_DIR = ROOT / "tools" / "lexicon"
FREQ_FILE = ROOT / "tools" / "freq" / "no_50k.txt"
OUT = ROOT / "data" / "words.json"

LEVELS = (300, 600, 1000)
LEVEL2 = 2000  # list core2: ranked after the 1000, all at level 2000
VOWELS = "aeiouyæøå"


def syllables(w):
    return len(re.findall(f"[{VOWELS}]+", w))


def drop_e(w):
    # keep the e when the stem would have no vowel left (skje, gre)
    return w[:-1] if w.endswith("e") and len(w) > 2 and syllables(w[:-1]) > 0 else w


def undouble(stem):
    if len(stem) > 2 and stem[-1] == stem[-2] and stem[-1] not in VOWELS:
        return stem[:-1]
    return stem


def noun_forms(lemma, g):
    if g == "m":
        if lemma.endswith("e"):
            return [lemma, lemma + "n", lemma + "r", lemma + "ne"]
        return [lemma, lemma + "en", lemma + "er", lemma + "ene"]
    if g == "f":
        if lemma.endswith("e"):
            s = lemma[:-1]
            return [lemma, f"{s}a/{lemma}n", lemma + "r", lemma + "ne"]
        return [lemma, f"{lemma}a/{lemma}en", lemma + "er", lemma + "ene"]
    if g == "n":
        if lemma.endswith("e"):
            return [lemma, lemma + "t", lemma + "r", f"{lemma}ne/{lemma[:-1]}a"]
        if syllables(lemma) == 1:
            return [lemma, lemma + "et", lemma, f"{lemma}ene/{lemma}a"]
        return [lemma, lemma + "et", lemma + "er", lemma + "ene"]
    raise ValueError(g)


def verb_forms(lemma, cls):
    stem = drop_e(lemma)
    pres = lemma + "r"
    if cls == "v1":
        return [lemma, pres, f"{stem}a/{stem}et", f"{stem}a/{stem}et"]
    if cls == "v2":
        s = undouble(stem)
        return [lemma, pres, s + "te", s + "t"]
    if cls == "v3":
        if lemma.endswith("e") and syllables(lemma[:-1]) > 0:  # prøve, greie, eie (not skje)
            return [lemma, pres, stem + "de", stem + "d"]
        return [lemma, pres, lemma + "dde", lemma + "dd"]
    raise ValueError(cls)


NATIONALITIES = {"norsk", "fransk", "engelsk", "tysk", "svensk", "dansk"}


def adj_forms(lemma):
    # -ig, -isk, nationalities and polysyllabic -sk keep the base form in the neuter (viktig, praktisk,
    # norsk, utenlandsk); short -sk adjectives take -t (rask -> raskt, frisk -> friskt)
    unchanged = (lemma.endswith(("ig", "isk", "t")) or lemma in NATIONALITIES
                 or (lemma.endswith("sk") and syllables(lemma) > 1))
    if unchanged or lemma[-1] in VOWELS and lemma.endswith("e"):
        neut = lemma
    elif len(lemma) > 2 and lemma[-1] == lemma[-2]:
        neut = lemma[:-1] + "t"
    else:
        neut = lemma + "t"
    pl = lemma if lemma.endswith("e") else lemma + "e"
    if lemma.endswith("ig"):
        return [lemma, neut, pl, lemma + "ere", lemma + "st"]
    return [lemma, neut, pl, lemma + "ere", lemma + "est"]


def merge(generated, explicit):
    if not explicit:
        return generated
    out = []
    n = max(len(generated), len(explicit))
    for i in range(n):
        e = explicit[i] if i < len(explicit) else ""
        g = generated[i] if i < len(generated) else ""
        out.append(e if e else g)
    return out


SLOT_NAMES = {
    "noun": ["indef", "def", "pl", "defpl"],
    "npl": ["pl", "defpl"],
    "verb": ["inf", "pres", "past", "perf"],
    "adj": ["base", "neut", "pl", "comp", "sup"],
}


def build_entry(fields, lst, group):
    fields += [""] * (6 - len(fields))
    lemma, pos, fr, en, forms_s, flags_s = [f.strip() for f in fields[:6]]
    npl_gender = ""
    if pos.startswith("npl-"):           # penger = npl-m, klær = npl-n: plural-only, but still a gender
        pos, npl_gender = "npl", pos[4:]
    explicit = [s.strip() for s in forms_s.split(",")] if forms_s else []
    flags = dict(f.split("=", 1) for f in flags_s.split() if "=" in f)

    kind = pos
    if pos in ("m", "f", "n"):
        kind = "noun"
        slots = merge(noun_forms(lemma, pos), explicit)
    elif pos == "npl":
        slots = explicit or [lemma, lemma + "e"]
    elif pos in ("v1", "v2", "v3"):
        kind = "verb"
        slots = merge(verb_forms(lemma, pos), explicit)
    elif pos == "v":
        kind = "verb"
        if len(explicit) < 4:
            raise ValueError(f"irregular verb needs 4 forms: {lemma}")
        slots = explicit
    elif pos == "adj":
        slots = merge(adj_forms(lemma), explicit)
    else:
        slots = [lemma] + explicit

    structured = {}
    names = SLOT_NAMES.get(kind if kind != "npl" else "npl")
    if pos == "npl":
        names = SLOT_NAMES["npl"]
    if names:
        for name, val in zip(names, slots):
            structured[name] = val

    variants = []
    for s in slots:
        for v in s.split("/"):
            v = v.strip().lower()
            if v and v not in variants:
                variants.append(v)
    if kind == "adj" and structured.get("sup"):
        for sup in structured["sup"].split("/"):
            sup = sup.strip().lower()
            defsup = sup if sup.endswith("e") else sup + "e"  # beste, største, viktigste
            if sup and defsup not in variants:
                variants.append(defsup)
    freqforms = list(variants)  # imperative excluded: it often collides (men, vekk, lei)
    if kind == "verb":
        if " " in lemma:  # phrasal verb: imperative of the head word + particle ("still inn", "kjøl ned")
            head, rest = lemma.split(" ", 1)
            h = drop_e(head)
            imp = h + " " + rest
            imp2 = h[:-1] + " " + rest if h.endswith("mm") else None  # tømme ut -> tøm ut
        else:
            imp = drop_e(lemma)
            imp2 = imp[:-1] if imp.endswith("mm") else None  # tømme -> tøm, komme -> kom
        passive = lemma + "s" if not lemma.endswith("s") and " " not in lemma else None
        for extra in (imp, imp2, passive):
            if extra and extra not in variants:
                variants.append(extra)
    if lemma.lower() not in variants:
        variants.insert(0, lemma.lower())
    # reflexive phrases: "sette seg" is also "setter meg / deg / oss / dere"
    if kind == "verb" and " seg" in lemma:
        for v in list(variants):
            for pron in ("meg", "deg", "oss", "dere"):
                alt = v.replace(" seg", " " + pron)
                if alt not in variants:
                    variants.append(alt)

    entry = {
        "lemma": lemma,
        "pos": kind if kind in ("noun", "verb") else pos,
        "fr": fr,
        "en": en,
        "list": lst,
    }
    if pos in ("m", "f", "n"):
        entry["gender"] = pos
    elif npl_gender:
        entry["gender"] = npl_gender
    if kind == "verb":
        entry["vclass"] = "irr" if pos == "v" else pos  # v1 kaste/kasta, v2 spise/spiste, v3 prøve/prøvde
    if structured:
        entry["forms"] = structured
    entry["variants"] = variants
    if group:
        entry["group"] = group
    if "freq" in flags:
        freqforms = [x.strip().lower() for x in flags["freq"].split(",")]
    entry["_freqforms"] = freqforms
    return entry


def load_freq():
    freq = {}
    with open(FREQ_FILE, encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) == 2:
                freq[parts[0]] = int(parts[1])
    return freq


def main():
    freq = load_freq()
    entries = []
    for path in sorted(LEX_DIR.glob("*.txt")):
        lst, group = "core", None
        for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if line.startswith("@list"):
                lst, group = line.split()[1], None
                continue
            if line.startswith("@group"):
                group = line.split(maxsplit=1)[1]
                continue
            try:
                entries.append(build_entry(line.split("|"), lst, group))
            except Exception as e:
                sys.exit(f"{path.name}:{n}: {e}\n  {raw}")

    seen = {}
    for e in entries:
        key = (e["lemma"], e["pos"])
        if key in seen:
            sys.exit(f"duplicate lemma: {key}")
        seen[key] = e
        base = e["lemma"].lower().replace(" ", "_")
        e["id"] = base if not any(
            x["lemma"].lower() == e["lemma"].lower() and x is not e for x in entries
        ) else f"{base}_{e['pos']}"
        forms = e.pop("_freqforms")
        e["freq"] = sum(freq.get(f, 0) for f in set(forms))

    core = sorted((e for e in entries if e["list"] == "core"), key=lambda e: -e["freq"])
    for rank, e in enumerate(core, 1):
        e["rank"] = rank
        e["level"] = next((lv for lv in LEVELS if rank <= lv), None)

    core2 = sorted((e for e in entries if e["list"] == "core2"), key=lambda e: -e["freq"])
    for i, e in enumerate(core2, 1):
        e["rank"] = LEVELS[-1] + i
        e["level"] = LEVEL2
    for e in entries:
        if e["list"] == "essentials":
            e["level"] = LEVELS[0]
        elif e["list"] not in ("core", "core2"):  # thematic lists (métier, vie locale)
            e["level"] = LEVELS[-1]

    out = [e for e in entries if e.get("level")]
    dropped = [e for e in core if not e.get("level")]
    order = {"core": 0, "core2": 1, "essentials": 2, "theme": 3}
    out.sort(key=lambda e: (order.get(e["list"], 9), e.get("rank", 0)))

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_core = sum(1 for e in out if e["list"] == "core")
    print(f"core candidates: {len(core)}  kept: {n_core}  dropped: {len(dropped)}")
    print(f"essentials: {sum(1 for e in out if e['list'] == 'essentials')}")
    print(f"theme: {sum(1 for e in out if e['list'] == 'theme')}")
    print(f"core2 (level 2000): {len(core2)}")
    if "--report" in sys.argv:
        zero = [e["lemma"] for e in core if e["freq"] == 0]
        print("zero freq:", ", ".join(zero))
        print("dropped (rank > 1000):", ", ".join(e["lemma"] for e in dropped))
        for lv in LEVELS:
            words = [e["lemma"] for e in core if e.get("level") == lv]
            print(f"\n--- level {lv} ({len(words)}) ---\n" + ", ".join(words))


if __name__ == "__main__":
    main()
