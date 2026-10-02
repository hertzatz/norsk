"""Verb drills in English: one MP3 per verb and voice that reads each form in English, then in Norwegian.

  to know, å vite. I know, jeg vet. I knew, jeg visste. I have known, jeg har visst.
  I will know, jeg skal vite. know!, vit!

Same method as gen_verb_audio.py (French): the English meaning comes from the lexicon, lemminflect
conjugates it, and the cases it cannot handle are written out below. British voices match the
Norwegian ones (Sonia with Pernille, Ryan with Finn); the Norwegian fragments are shared with the
French drills. The app plays these when the first translation language is English (EN, EN+FR).
Output: audio/<voice>/verb_en/<verb id>.mp3, plus data/verb_drills_en.json (the texts, to review).
Usage: python gen_verb_audio_en.py            (texts + audio)
       python gen_verb_audio_en.py --texts    (texts only, printed for review)
"""
import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

from lemminflect import getInflection

sys.path.insert(0, str(Path(__file__).parent))
from gen_audio import slug  # noqa: E402
from gen_verb_audio import (FF, FR_FULL, FRAG, IMPERSONAL, MODALS, OUT, PAUSE_NEXT, PAUSE_PAIR,  # noqa: E402
                            RECIPROCAL, norwegian_forms, silence, synth_all)

ROOT = Path(__file__).resolve().parent.parent
VOICES = {"pernille": ("en-GB-SoniaNeural", "nb-NO-PernilleNeural"),
          "finn": ("en-GB-RyanNeural", "nb-NO-FinnNeural")}
ORDER = ("inf", "pres", "past", "perf", "fut", "imp")

# (past, past participle) where lemminflect picks the wrong form for this meaning, or the American one
# while the voices are British
FORMS = {"get": ("got", "got"), "lie": ("lay", "lain"), "wake": ("woke", "woken"), "light": ("lit", "lit"),
         "ski": ("skied", "skied"), "fit": ("fitted", "fitted"), "knit": ("knitted", "knitted"),
         "smell": ("smelled", "smelled"), "spell": ("spelled", "spelled"),
         "travel": ("travelled", "travelled"), "shovel": ("shovelled", "shovelled")}
# English meanings the conjugator cannot use as they are (key = verb id): a better head
EN_FIX = {"regne": "calculate"}   # as in the French track (calculer), not "rain"
# forms written out: [infinitive, present, past, perfect, future, imperative] (None = no such form)
EN_FULL = {
    "kunne": ["to be able to", "I can", "I could", "I have been able to", None, None],
    "skulle": ["to be going to", "I shall", "I was going to", "I have been supposed to", None, None],
    "måtte": ["to have to", "I must", "I had to", "I have had to", None, None],
    "burde": ["should", "I should", "I was supposed to", "I should have", None, None],
    "lyve": ["to lie", "I lie", "I lied", "I have lied", "I will lie", "lie!"],   # tell lies, not lie down
    "pleie": ["to be in the habit of", "I am in the habit of", "I was in the habit of",
              "I have been in the habit of", "I will be in the habit of", None],
}


def head_of(gloss):
    g = re.sub(r"\([^)]*\)?", "", gloss)          # "know (a fact)", "cut (scissors, hair)"
    return re.sub(r"\s+", " ", re.split(r"[,;]", g)[0]).strip()


def parts(verb, subj):
    """present (for this subject), past, past participle"""
    if verb == "be":
        return {"I": "am", "it": "is", "we": "are"}[subj], "were" if subj == "we" else "was", "been"
    past, pp = getInflection(verb, "VBD"), getInflection(verb, "VBN")
    if not past or not pp:
        return None
    pres = getInflection(verb, "VBZ")[0] if subj == "it" else verb
    return (pres,) + FORMS.get(verb, (past[0], pp[0]))


def english_forms(head, subj="I"):
    """[infinitive, present, past, perfect, future, imperative], or None"""
    words = head.split()
    if not words:
        return None
    verb, rest = words[0], " ".join(words[1:])
    p = parts(verb, subj)
    if not p:
        return None
    pres, past, pp = p
    me = {"I": "myself", "it": "itself", "we": "ourselves"}[subj]
    tail = lambda s, who=me: (s + " " + rest).strip().replace("oneself", who)
    have = "has" if subj == "it" else "have"
    return ["to " + head, f"{subj} {tail(pres)}", f"{subj} {tail(past)}", f"{subj} {have} {tail(pp)}",
            f"{subj} will {tail(verb)}", tail(verb, "yourself") + "!"]


def build():
    words = json.loads((ROOT / "data" / "words.json").read_text(encoding="utf-8"))
    drills, failed = {}, []
    for w in (x for x in words if x["pos"] == "verb"):
        vid = w["id"]
        subj, subj_no = "I", "jeg"
        if vid in IMPERSONAL or vid in FR_FULL:
            subj, subj_no = "it", "det"
        elif vid in RECIPROCAL:
            subj, subj_no = "we", "vi"
        head = EN_FIX.get(vid, head_of(w["en"]))
        en = EN_FULL.get(vid) or english_forms(head, subj)
        no = norwegian_forms(w, subj_no)
        if not en:
            failed.append(f"{w['lemma']}: {w['en']}")
            pairs = [[head, no[0][1]]] + [[None, t] for _, t in no[1:]]
        else:
            pairs = [[en[ORDER.index(k)], t] for k, t in no]
        drills[vid] = pairs                # same English text for both voices
    return drills, failed


def main():
    drills, failed = build()
    (ROOT / "data" / "verb_drills_en.json").write_text(json.dumps(drills, ensure_ascii=False, indent=0), encoding="utf-8")
    if "--texts" in sys.argv:
        for vid, pairs in drills.items():
            print(f"{vid}: " + " | ".join(f"{en} = {no}" for en, no in pairs))
        print(f"\n{len(drills)} verbs, English conjugation failed for {len(failed)}")
        for f in failed:
            print("  NO EN", f)
        return
    jobs, frag = [], {}
    for voice, (en_voice, no_voice) in VOICES.items():
        (FRAG / voice).mkdir(parents=True, exist_ok=True)
        for pairs in drills.values():
            for en, no in pairs:
                for lang, text, vname in (("en", en, en_voice), ("no", no, no_voice)):
                    if text:
                        p = FRAG / voice / f"{lang}_{slug(text)}.mp3"
                        frag[(voice, lang, text)] = p
                        jobs.append((vname, text, p))
    uniq = list({j[2]: j for j in jobs}.values())
    print(f"{len(drills)} verbs, {len(uniq)} fragments to check")
    asyncio.run(synth_all(uniq))
    missing = [str(p) for (_, _, p) in uniq if not (p.exists() and p.stat().st_size)]
    if missing:
        print(f"{len(missing)} fragments could not be synthesised, e.g. {missing[:3]}")
        return
    short, long_ = silence(PAUSE_PAIR), silence(PAUSE_NEXT)
    made = 0
    for vid, pairs in drills.items():
        for voice in VOICES:
            out = OUT / voice / "verb_en" / f"{vid}.mp3"
            out.parent.mkdir(parents=True, exist_ok=True)
            seq = []
            for en, no in pairs:
                if en:
                    seq += [frag[(voice, "en", en)], short]
                seq += [frag[(voice, "no", no)], long_]
            lst = FRAG / "list_en.txt"
            lst.write_text("".join(f"file '{p.resolve().as_posix()}'\n" for p in seq), encoding="utf-8")
            subprocess.run([FF, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                            "-ar", "24000", "-ac", "1", "-b:a", "32k", str(out)], check=True)
            made += 1
    print(f"written {made} files; English conjugation failed for {len(failed)} verbs")


if __name__ == "__main__":
    main()
