# Norsk · Rollag

Outil personnel d'apprentissage du norvégien (bokmål), ciblé sur la vie quotidienne et le travail (restauration, nettoyage) dans le Numedal.

- 1000 mots classés par niveau (300 / 600 / 1000) + essentiels + vocabulaire métier
- ~4950 phrases, chaque mot dans au moins 5 phrases de son niveau, traductions FR et EN
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
