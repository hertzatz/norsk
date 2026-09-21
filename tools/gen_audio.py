"""Generate MP3 files for every word and sentence with edge-tts (Microsoft neural voices).

Only missing files are generated, so the script can be re-run after adding content.
Layout (same as the Cloudflare R2 bucket, see upload_r2.py): audio/<voice>/w/<slug>.mp3 (words)
and audio/<voice>/s100/<id>.mp3 (sentences, normal speed). Slower sentence versions are spoken
slower by the voice itself (no browser time-stretch); the folder name is the speed in percent:
  audio/<voice>/s085/ (85 %), s070/ (70 %), s055/ (55 %).
Usage: python gen_audio.py [pernille] [finn] [s100|s085|s070|s055 ...]   (default: both voices, s100)
File names come from slug(), which must stay identical to slug() in app.js.
"""
import asyncio
import json
import sys
import unicodedata
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "audio"
VOICES = {"pernille": "nb-NO-PernilleNeural", "finn": "nb-NO-FinnNeural"}
CONCURRENCY = 6
# sentence folder (speed in %) -> (edge-tts rate, root folder)
SPEEDS = {"s100": ("+0%", "audio"), "s085": ("-15%", "audio"),
          "s070": ("-30%", "audio"), "s055": ("-45%", "audio")}


def slug(text):
    t = text.lower().strip()
    t = t.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
    t = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    out = []
    for ch in t:
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "_":
            out.append("_")
    return "".join(out).strip("_")[:80]


def imperative(inf):
    """Same rule as imperative() in app.js."""
    if not inf.endswith("e") or len(inf) < 3 or not any(c in "aeiouyæøå" for c in inf[:-1]):
        return inf
    imp = inf[:-1]
    return imp[:-1] if imp.endswith("mm") else imp


def shown_forms(w):
    """Every form the app displays (and makes clickable) for a word: cards, popovers, tables."""
    f = w.get("forms") or {}
    split = lambda s: [x.strip() for x in (s or "").split("/") if x.strip()]
    out = [w["lemma"]]
    for key in ("inf", "pres", "past", "perf", "indef", "def", "pl", "defpl", "base", "neut", "comp", "sup"):
        out += split(f.get(key))
    if w["pos"] == "verb" and " " not in w["lemma"]:
        out += ["har " + p for p in split(f.get("perf"))]
        if f.get("inf"):
            out += ["skal " + f["inf"], "vil " + f["inf"], imperative(f["inf"])]
        if w["lemma"] + "s" in w["variants"]:
            out.append(w["lemma"] + "s")
    if w["pos"] in ("pron", "det"):
        out += w["variants"]
    return out


def collect():
    texts = {}
    words = json.loads((ROOT / "data" / "words.json").read_text(encoding="utf-8"))
    for w in words:
        for form in shown_forms(w):
            texts.setdefault(("w", slug(form)), form)
    sent_file = ROOT / "data" / "sentences.json"
    if sent_file.exists():
        for s in json.loads(sent_file.read_text(encoding="utf-8")):
            texts.setdefault(("s", s["id"]), s["no"])
            for tok in s["tokens"]:
                if tok.get("w"):
                    texts.setdefault(("w", slug(tok["t"])), tok["t"])
    return texts


async def synth(sem, voice, kind, name, text, stats, rate="+0%", root=None):
    path = (root or AUDIO) / voice / kind / f"{name}.mp3"
    if path.exists() and path.stat().st_size > 0:
        stats["skip"] += 1
        return
    async with sem:
        for attempt in range(4):
            try:
                await edge_tts.Communicate(text, VOICES[voice], rate=rate).save(str(path))
                stats["ok"] += 1
                return
            except Exception as e:
                if attempt == 3:
                    stats["fail"].append(f"{text}: {e}")
                await asyncio.sleep(2 * (attempt + 1))


async def main():
    texts = collect()
    for (kind, name), text in texts.items():
        if not name:
            sys.exit(f"empty slug for {text!r}")
    voices = [v for v in VOICES if v in sys.argv[1:]] or list(VOICES)
    speeds = [s for s in SPEEDS if s in sys.argv[1:]] or ["s100"]
    stats = {"ok": 0, "skip": 0, "fail": []}
    sem = asyncio.Semaphore(CONCURRENCY)
    jobs = []
    for sdir in speeds:
        rate, rootname = SPEEDS[sdir]
        root = ROOT / rootname
        normal = sdir == "s100"
        for voice in voices:
            for kind in (("w", sdir) if normal else (sdir,)):
                (root / voice / kind).mkdir(parents=True, exist_ok=True)
            for (k, n), t in texts.items():
                if k == "s":
                    jobs.append(synth(sem, voice, sdir, n, t, stats, rate, root))
                elif normal:  # words exist at normal speed only: too short to stutter when slowed
                    jobs.append(synth(sem, voice, k, n, t, stats))
    await asyncio.gather(*jobs)
    print(f"generated {stats['ok']}, already present {stats['skip']}, failed {len(stats['fail'])}")
    for f in stats["fail"]:
        print("  FAIL", f)


if __name__ == "__main__":
    asyncio.run(main())
