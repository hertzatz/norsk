# Norsk — Cahier des charges (v0.2)

Outil personnel d'apprentissage du norvégien (bokmål) pour vivre et travailler à Rollag (Numedal).

## 1. Objectif

Apprendre le norvégien parlé du quotidien et du travail (restauration, nettoyage) à partir des mots les plus fréquents, par paliers de **300 / 600 / 1000 mots**, avec des phrases qui se limitent à ces mots, leur traduction et leur audio.

## 2. Décisions prises

| Sujet | Choix |
|---|---|
| Langue écrite | Bokmål |
| Contexte | Vie quotidienne + travail (restauration, nettoyage) |
| Traductions | Français **et** anglais (affichables ensemble ou séparément) |
| Audio | Chaque mot cliquable individuellement + lecture de la phrase entière |
| Supports | PC et téléphone → site HTML statique, installable (PWA), utilisable hors ligne |
| Progression | Optionnelle (activable/désactivable) |
| Dialecte local | Pas pour l'instant (prévu en V2 : enregistrement de voix locales) |
| Formes écrites | Bokmål « de l'Est », proche de l'oral de Kongsberg/Numedal : féminin en *-a* (*ei jente, jenta, boka*), passé en *-a* des verbes faibles (*snakka, kasta*), quand le bokmål officiel l'autorise |
| Niveaux | Sélecteur **300 / 600 / 1000** dans l'application |
| Essentiels | Nombres, jours, mois, heure : liste à part, **ajoutée en plus** des 300 (disponible dès le niveau 300) |
| Hébergement | GitHub Pages, compte GitHub **hertzatz** |

## 3. Vocabulaire

### 3.1 Tronc commun (fréquence)
- Source : liste de fréquence du norvégien parlé (sous-titres, projet *FrequencyWords*) recoupée avec Språkbanken.
- Regroupement par **lemme** (ex. *være* regroupe *er, var, vært*).
- Nettoyage : suppression des noms propres, interjections parasites, anglicismes de sous-titres.
- Paliers : **N1 = 300**, **N2 = 600**, **N3 = 1000** (cumulatifs).

### 3.2 Vocabulaire métier (complément)
Les mots du travail (*oppvaskmaskin, gulv, bestilling, vaskemiddel, skift*…) ne figurent pas dans les 1000 mots les plus fréquents. On ajoute donc des listes thématiques séparées, d'environ 100 à 150 mots chacune :
- **Restauration** (cuisine, service, clients, hygiène)
- **Nettoyage** (produits, surfaces, matériel, consignes)
- **Travail général** (horaires, collègues, salaire, NAV, sécurité)

Une phrase peut combiner le tronc commun du niveau et un thème métier choisi.

### 3.3 Fiche d'un mot
- lemme + formes principales (noms : indéfini/défini, sing./pluriel ; verbes : infinitif, présent, passé, participe ; adjectifs : accords)
- genre (*en / ei / et*) pour les noms
- traduction FR + EN
- rang de fréquence, niveau, thème(s)
- audio du lemme et de chaque forme utilisée dans les phrases

## 4. Phrases

- Chaque phrase n'utilise **que** des mots du niveau choisi (et éventuellement du thème métier sélectionné).
- **Couverture complète** : chaque mot de la liste apparaît dans **au moins 5 phrases** de son niveau. Le script de validation liste les mots non couverts.
- Vérification **automatique** par un script : chaque mot de chaque phrase est rattaché à un lemme de la liste. Une phrase qui échoue est rejetée.
- Phrases courtes et utiles à l'oral : questions, réponses, consignes, politesse.
- Objectif indicatif : ~150 phrases en N1, ~300 en N2, ~500 en N3, plus ~100 par thème métier.
- Chaque phrase : texte norvégien, traduction FR, traduction EN, niveau, thème, liste des mots (forme → lemme).

## 5. Fonctionnalités

### 5.1 Lecture de phrases (cœur de l'outil)
- Phrase affichée avec **chaque mot cliquable** : clic → audio du mot + infobulle (lemme, traduction FR/EN).
- Bouton ▶ phrase entière ; vitesse réglable globalement (×1 / ×0,85 / ×0,7 / ×0,55) ; voix Pernille, Finn ou les deux.
- Infobulle d'un mot : traduction FR/EN, catégorie, formes étiquetées :
  - verbes : infinitif, présent, prétérit, passé composé, futur (skal/vil), impératif ;
  - noms : indéfini, défini, pluriel, pluriel défini ;
  - adjectifs : masc./fém., neutre, pluriel/défini, comparatif, superlatif.
- **Double-clic sur un mot** (ou bouton 📚) : panneau listant toutes les phrases qui contiennent ce mot (au niveau choisi, puis aux niveaux supérieurs).
- Mots « bonus » (hors niveau, max 20 % d'une phrase) soulignés en pointillés.
- Traductions FR / EN masquables (pour s'auto-tester).

### 5.2 Liste de mots
- Parcours par niveau et par thème, recherche (NO/FR/EN).
- Fiche du mot : formes, audio, phrases d'exemple qui l'utilisent.

### 5.2 bis Verbes et pronoms
- Onglet **Verbes** : tous les verbes du niveau, avec infinitif, présent, prétérit, passé composé, futur et impératif ; irréguliers à part, réguliers groupés (-a/-et, -te, -de). Chaque forme est cliquable (audio) ; 📚 ouvre les phrases du verbe.
- Onglet **Pronoms** : tableau sujet / complément / possessif, règles (possessif après le nom, accord min/mi/mitt/mine, sin/hans) et autres pronoms et déterminants du niveau.
- Onglet **Mots** : bouton « 📚 N phrases » sur chaque mot.

### 5.3 Cartes mémoire (répétition espacée)
- Sens : NO → FR/EN, FR/EN → NO, audio → sens.
- Algorithme de répétition espacée simple (type SM-2).

### 5.4 Quiz
- Choix multiples (sens d'un mot, traduction d'une phrase).
- Remise en ordre des mots d'une phrase.

### 5.5 Dictée
- Écouter un mot ou une phrase et l'écrire, avec correction tolérante (accents, *æ/ø/å*).

### 5.6 Progression (optionnelle)
- Stockée localement sur l'appareil (localStorage).
- Export/import d'un fichier JSON pour synchroniser PC ↔ téléphone.

## 6. Audio

- Voix : norvégien standard de l'Est (synthèse vocale neuronale).
- Génération **une seule fois** par script → fichiers MP3 dans `audio/` :
  - un fichier par phrase ;
  - un fichier par forme de mot distincte (*hus*, *huset*, *husene*…).
- Moteur recommandé : **Azure TTS** (`nb-NO-PernilleNeural` / `FinnNeural`, palier gratuit suffisant). Solution de repli sans compte : **Piper** (hors ligne).
- Secours dans l'application : Web Speech API du navigateur si un fichier manque.
- Format compact (mono, faible débit) pour rester léger sur téléphone.

## 7. Technique

- HTML + CSS + JavaScript sans framework ni étape de compilation.
- Données en JSON : `data/words.json`, `data/sentences.json`, `data/themes.json`.
- PWA : manifest + service worker → installable sur l'écran d'accueil, fonctionne hors ligne.
- Hébergement gratuit (GitHub Pages ou équivalent) : nécessaire pour l'utiliser sur téléphone.
- Scripts de préparation (Python ou Node) dans `tools/` :
  1. construction de la liste de mots ;
  2. validation des phrases ;
  3. génération audio.

## 8. Étapes

1. Liste des 1000 lemmes + traductions FR/EN (générées, puis relues).
2. Listes métier (restauration, nettoyage, travail).
3. Phrases + script de validation.
4. Génération audio.
5. Application : lecture de phrases → liste de mots → cartes → quiz → dictée.
6. Progression + PWA/hors ligne + mise en ligne.

## 8 bis. État d'avancement (18/09/2026)
- [x] Vocabulaire : 1000 mots classés (300/600/1000) + **niveau 2000** (996 mots supplémentaires : verbes, noms, adjectifs, adverbes, verbes à particule, expressions) + 130 essentiels + 136 mots métier et vie locale.
- [x] Phrases : ~7870 phrases, **chaque mot dans au moins 5 phrases de son niveau, y compris au niveau 2000** (validé par script), tolérance de 20 % de mots bonus par phrase.
- [x] Audio : deux voix (Pernille, Finn) pour tous les mots, formes et phrases, en alternance à chaque lecture en mode « Both ».
- [x] Application : phrases cliquables, formes étiquetées (temps des verbes), double-clic → phrases d'un mot, filtres niveau/thème/catégorie, recherche NO/FR/EN sans accents, vitesse et voix réglables, onglets Verbs et Pronouns, interface en anglais, case « Only this level » (n'affiche que les mots et phrases du niveau choisi), tout mot norvégien cliquable partout.
- [x] Mise en ligne GitHub Pages : https://hertzatz.github.io/norsk/
- [ ] Cartes mémoire, quiz, dictée.
- [ ] Progression, PWA hors ligne.

## 9. Hors périmètre V1 (idées V2)
- Enregistrement de voix locales (numedalsmål) et comparaison standard / local.
- Notes de dialecte sur les mots où le parler de Numedal diffère nettement.

## 10. Questions ouvertes
- [x] Formes : *-a* (proche Kongsberg/Numedal).
- [x] Hébergement : GitHub Pages, compte hertzatz.
- [x] Essentiels (nombres, jours, mois, heure) : en plus des 300.
- [x] Moteur audio : edge-tts (voix neuronales Microsoft), **deux voix** : Pernille (♀) et Finn (♂), au choix dans l'application ou en alternance.
- [x] Vitesse : audio généré à vitesse normale, **vitesse réglable dans l'application** (×1 / ×0,85 / ×0,7 / ×0,55), sans changer la hauteur de la voix.
- [x] Traductions : rédigées à la main (pas de Google Translate) ; vérification croisée possible plus tard.
