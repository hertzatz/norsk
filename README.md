# Norsk · Rollag

Outil personnel d'apprentissage du norvégien (bokmål), ciblé sur la vie quotidienne et le travail (restauration, nettoyage) dans le Numedal.

- ~2000 mots classés par niveau (300 / 600 / 1000 / 2000) + essentiels + vocabulaire métier
- ~8000 phrases, chaque mot dans au moins 5 phrases de son niveau (300 / 600 / 1000 / 2000), traductions FR et EN
- Audio pour chaque mot, forme et phrase (voix Pernille et Finn)
- Onglets : Sentences, Words, Verbs, Pronouns

## Développement

```
python tools/build_words.py       # tools/lexicon/*.txt  -> data/words.json
python tools/build_sentences.py   # tools/sentences/*.txt -> data/sentences.json (+ contrôle de couverture)
python tools/gen_audio.py         # génère les MP3 manquants (edge-tts)
python -m http.server 8765        # puis http://localhost:8765/
```

Voir [CAHIER_DES_CHARGES.md](CAHIER_DES_CHARGES.md).

## Audio

Les fichiers audio (~85 000 mp3, 1,7 Go) ne sont pas dans ce dépôt : ils sont servis depuis un bucket
Cloudflare R2 (`norsk-app`, adresse publique dans `AUDIO_BASE` de `app.js`).

```
python tools/gen_audio.py [s100 s085 s070 s055]   # mots et phrases -> audio/<voix>/… (local, ignoré par git)
python tools/gen_verb_audio.py                     # pistes des verbes (français puis norvégien) -> audio/<voix>/verb/
python tools/upload_r2.py                          # envoie ce qui manque dans le bucket (clés dans ../../.norsk-r2.env)
```
