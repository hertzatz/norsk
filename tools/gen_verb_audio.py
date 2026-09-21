"""Verb drills: one MP3 per verb and voice that reads each form in French, then in Norwegian.

  savoir, å vite. je sais, jeg vet. je savais, jeg visste. j'ai su, jeg har visst.
  je saurai, jeg skal vite. sache !, vit !

The French voice matches the Norwegian one (Denise with Pernille, Henri with Finn), so French
past participles agree with the speaker (je suis allée / je suis allé).
Output: norsk-db/<voice>/verb/<verb id>.mp3, plus data/verb_drills.json (the texts, to review).
Fragments are cached in tools/.frag/ so a re-run only synthesises what changed.
Usage: python gen_verb_audio.py
"""
import asyncio
import json
import logging
import re
import subprocess
import sys
from pathlib import Path

import edge_tts
import imageio_ffmpeg

sys.path.insert(0, str(Path(__file__).parent))
from gen_audio import imperative, slug  # noqa: E402

logging.disable(logging.CRITICAL)
from verbecc import CompleteConjugator  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FRAG = Path(__file__).parent / ".frag"
OUT = ROOT / "norsk-db"
FF = imageio_ffmpeg.get_ffmpeg_exe()
VOICES = {"pernille": ("fr-FR-DeniseNeural", "nb-NO-PernilleNeural", "f"),
          "finn": ("fr-FR-HenriNeural", "nb-NO-FinnNeural", "m")}
PAUSE_PAIR, PAUSE_NEXT = 0.35, 0.5   # after the French form / after each pair
MODALS = {"kunne", "ville", "skulle", "måtte", "burde"}
CONCURRENCY = 6

# French glosses the conjugator cannot use as they are (key = verb id)
FR_FIX = {
    "gulve": "laver le sol", "støvsuge": "passer l'aspirateur", "regne": "calculer",
    "slappe": "se détendre", "skynde": "se dépêcher", "kjede": "s'ennuyer", "klippe": "couper",
    "mase": "insister", "bake": "faire du pain", "komme_seg": "se remettre",
}
# Impersonal verbs: Norwegian subject "det", French subject (il / ça)
IMPERSONAL = {"skje": ("il", "se passer"), "hende": ("il", "arriver"),
              "koste": ("ça", "coûter"), "gjelde": ("ça", "concerner"), "lyde": ("ça", "sonner"),
              "gjelde_for": ("ça", "s'appliquer à"), "vare_ved": ("ça", "continuer")}
# Impersonal with être: the French forms are written out
FR_FULL = {"snø_verb": ["neiger", "il neige", "il neigeait", "il a neigé", "il neigera", None],
           "gå_an": ["être possible", "c'est possible", "c'était possible", "ça a été possible", "ce sera possible", None],
           "stemme_verb": ["être exact", "c'est exact", "c'était exact", "ça a été exact", "ce sera exact", None]}
# Norwegian lemma lacks its particle / reflexive in the lexicon: added to every form
NO_SUFFIX = {"slappe": " av", "skynde": " seg", "kjede": " seg"}
# imperatives that make no sense as a drill
NO_IMP = {"se_ut", "ha_lyst_på", "gidde", "orke", "rekke", "trenge", "pleie", "komme_til_å", "sulte", "fryse",
          "hete_verb", "finnes", "lykkes", "trives", "synes", "hende", "skje", "koste"}
RECIPROCAL = {"møtes"}   # vi møtes = nous nous rencontrons
ETRE = {"apparaître"}    # passé composé with être despite the conjugator
AVOIR_WITH_OBJECT = {"passer", "monter", "descendre", "sortir", "rentrer", "retourner"}
H_ASPIRE = {"hacher", "harceler", "haïr", "hurler"}

cg = CompleteConjugator(lang="fr")
_cache = {}


def conj(verb):
    if verb not in _cache:
        try:
            _cache[verb] = json.loads(str(cg.conjugate(verb)))["moods"]
        except Exception:
            _cache[verb] = None
    return _cache[verb]


def pick(entries, person, number, gender):
    cands = [e for e in entries if e.get("p") == person and e.get("n") == number]
    for e in cands:
        if e.get("g", gender) == gender:
            return e["c"][0]
    return cands[0]["c"][0] if cands else None


def french_forms(gloss, gender, person=("1", "s"), subject=None):
    """[infinitive, présent, imparfait, passé composé, futur, impératif], or None.
    person = ("1","s") for je, ("1","p") for nous, ("3","s") with subject "il"/"ça" for impersonal verbs."""
    head = re.split(r"[,;]", gloss)[0]
    head = re.sub(r"\(.*?\)", "", head).replace("(", "").strip()
    words = head.split()
    if head.startswith("s'"):
        n = 1
    elif words and words[0] == "se":
        n = 2
    else:
        n = 1
    verb, rest = " ".join(words[:n]), (" " + " ".join(words[n:])) if len(words) > n else ""
    m = conj(verb)
    if not m:
        return None
    try:
        ind = m["indicatif"]
        p, num = person
        g = gender if p != "3" else "m"
        forms = [pick(ind[k], p, num, g) for k in ("présent", "imparfait", "passé-composé", "futur-simple")]
        base = verb[3:] if verb.startswith("se ") else verb[2:] if verb.startswith("s'") else verb
        pps = m["participe"]["participe-passé"]
        pp_m = pps[0]["c"][0] if pps else ""
        if base in ETRE and p == "1" and num == "s":
            forms[2] = "je suis " + pp_m + ("e" if gender == "f" else "")
        if rest and base in AVOIR_WITH_OBJECT and p == "1" and num == "s" and " suis " in forms[2]:
            forms[2] = "j'ai " + pp_m
        if base in H_ASPIRE:
            forms = [f.replace("j'h", "je h") for f in forms]
        forms = [f + rest for f in forms]
        if subject:  # impersonal: "il" stays, "ça" replaces it
            forms = [("ça " + f[3:]) if subject == "ça" and f.startswith("il ") else f for f in forms]
        imp = None
        if person == ("1", "s") and not subject:
            i = pick(m["imperatif"]["imperatif-présent"], "2", "s", gender)
            imp = (i + rest + " !") if i else None
        return [head] + forms + [imp]
    except Exception:
        return None


def norwegian_forms(w, subj="jeg"):
    suffix = NO_SUFFIX.get(w["id"], "")
    f = {k: ((v.split("/")[0].strip() + suffix) if isinstance(v, str) else v) for k, v in w["forms"].items()}
    first = lambda s: (s or "").split("/")[0].strip()
    me = lambda s: s.replace(" seg", " meg") if subj == "jeg" else s
    lemma = w["lemma"]
    deponent = lemma.endswith("s") and first(f["pres"]) == f["inf"]
    rows = [("inf", "å " + f["inf"]),
            ("pres", f"{subj} " + me(first(f["pres"]))),
            ("past", f"{subj} " + me(first(f["past"]))),
            ("perf", f"{subj} har " + me(first(f["perf"])))]
    if subj != "jeg":
        if lemma not in MODALS:
            rows.append(("fut", f"{subj} skal " + f["inf"]))
        return rows
    if lemma not in MODALS and not deponent:
        rows.append(("fut", "jeg skal " + me(f["inf"])))
        if w["id"] not in NO_IMP:
            head, _, rest = f["inf"].partition(" ")
            imp = imperative(head) + ((" " + rest.replace("seg", "deg")) if rest else "")
            rows.append(("imp", imp + "!"))
    return rows


def build():
    words = json.loads((ROOT / "data" / "words.json").read_text(encoding="utf-8"))
    verbs = [w for w in words if w["pos"] == "verb"]
    drills, failed = {}, []
    for w in verbs:
        vid = w["id"]
        gloss = FR_FIX.get(vid, w["fr"])
        subject, person, subj_no = None, ("1", "s"), "jeg"
        if vid in IMPERSONAL:
            subject, gloss = IMPERSONAL[vid]
            person, subj_no = ("3", "s"), "det"
        elif vid in FR_FULL:
            subj_no = "det"
        elif vid in RECIPROCAL:
            person, subj_no = ("1", "p"), "vi"
        per_voice = {}
        for voice, (_, _, gender) in VOICES.items():
            fr = FR_FULL.get(vid) or french_forms(gloss, gender, person, subject)
            no = norwegian_forms(w, subj_no)
            if not fr:
                failed.append(f"{w['lemma']}: {gloss}")
                pairs = [[re.sub(r"\(.*?\)", "", re.split(r"[,;]", gloss)[0]).strip(), no[0][1]]] + [[None, t] for _, t in no[1:]]
            else:
                idx = {"inf": 0, "pres": 1, "past": 2, "perf": 3, "fut": 4, "imp": 5}
                pairs = [[fr[idx[k]], t] for k, t in no]
            per_voice[voice] = pairs
        drills[w["id"]] = per_voice
    return drills, failed


async def synth_all(jobs):
    sem = asyncio.Semaphore(CONCURRENCY)

    async def one(voice_name, text, path):
        if path.exists() and path.stat().st_size:
            return
        async with sem:
            for attempt in range(4):
                try:
                    await edge_tts.Communicate(text, voice_name).save(str(path))
                    return
                except Exception:
                    await asyncio.sleep(2 * (attempt + 1))
    await asyncio.gather(*(one(*j) for j in jobs))


def silence(d):
    p = FRAG / f"sil{d}.mp3"
    if not p.exists():
        subprocess.run([FF, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                        "-t", str(d), "-b:a", "48k", str(p)], check=True)
    return p


def main():
    drills, failed = build()
    (ROOT / "data" / "verb_drills.json").write_text(json.dumps(drills, ensure_ascii=False, indent=0), encoding="utf-8")
    jobs, frag = [], {}
    for voice, (fr_voice, no_voice, _) in VOICES.items():
        (FRAG / voice).mkdir(parents=True, exist_ok=True)
        for per_voice in drills.values():
            for fr, no in per_voice[voice]:
                for lang, text, vname in (("fr", fr, fr_voice), ("no", no, no_voice)):
                    if text:
                        p = FRAG / voice / f"{lang}_{slug(text)}.mp3"
                        frag[(voice, lang, text)] = p
                        jobs.append((vname, text, p))
    uniq = list({j[2]: j for j in jobs}.values())
    print(f"{len(drills)} verbs, {len(uniq)} fragments to check")
    asyncio.run(synth_all(uniq))
    short, long_ = silence(PAUSE_PAIR), silence(PAUSE_NEXT)
    made = 0
    for vid, per_voice in drills.items():
        for voice in VOICES:
            out = OUT / voice / "verb" / f"{vid}.mp3"
            out.parent.mkdir(parents=True, exist_ok=True)
            seq = []
            for fr, no in per_voice[voice]:
                if fr:
                    seq += [frag[(voice, "fr", fr)], short]
                seq += [frag[(voice, "no", no)], long_]
            lst = FRAG / "list.txt"
            lst.write_text("".join(f"file '{p.resolve().as_posix()}'\n" for p in seq), encoding="utf-8")
            subprocess.run([FF, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                            "-ar", "24000", "-ac", "1", "-b:a", "32k", str(out)], check=True)
            made += 1
    print(f"written {made} files; French conjugation failed for {len(failed) // 2} verbs")
    for f in sorted(set(failed)):
        print("  NO FR", f)


if __name__ == "__main__":
    main()
