"""Generate MP3 files for every word and sentence with edge-tts (Microsoft neural voices).

Only missing files are generated, so the script can be re-run after adding content.
Layout: audio/<voice>/w/<slug>.mp3 (words) and audio/<voice>/s/<id>.mp3 (sentences).
Usage: python gen_audio.py [pernille] [finn]   (default: both)
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


def collect():
    texts = {}
    words = json.loads((ROOT / "data" / "words.json").read_text(encoding="utf-8"))
    for w in words:
        texts.setdefault(("w", slug(w["lemma"])), w["lemma"])
    sent_file = ROOT / "data" / "sentences.json"
    if sent_file.exists():
        for s in json.loads(sent_file.read_text(encoding="utf-8")):
            texts.setdefault(("s", s["id"]), s["no"])
            for tok in s["tokens"]:
                if tok.get("w"):
                    texts.setdefault(("w", slug(tok["t"])), tok["t"])
    return texts


async def synth(sem, voice, kind, name, text, stats):
    path = AUDIO / voice / kind / f"{name}.mp3"
    if path.exists() and path.stat().st_size > 0:
        stats["skip"] += 1
        return
    async with sem:
        for attempt in range(4):
            try:
                await edge_tts.Communicate(text, VOICES[voice]).save(str(path))
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
    for voice in voices:
        for kind in ("w", "s"):
            (AUDIO / voice / kind).mkdir(parents=True, exist_ok=True)
    stats = {"ok": 0, "skip": 0, "fail": []}
    sem = asyncio.Semaphore(CONCURRENCY)
    await asyncio.gather(*(synth(sem, v, k, n, t, stats) for v in voices for (k, n), t in texts.items()))
    print(f"generated {stats['ok']}, already present {stats['skip']}, failed {len(stats['fail'])}")
    for f in stats["fail"]:
        print("  FAIL", f)


if __name__ == "__main__":
    asyncio.run(main())
